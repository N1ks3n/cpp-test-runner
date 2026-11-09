import * as vscode from "vscode";
import { spawn } from "node:child_process";
import * as path from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { XMLParser, XMLValidator } from "fast-xml-parser";

// Один объект — лог одного запуска.
class RunLog {
    private readonly chunks: string[] = [];
    private readonly startedAt = new Date();

    public constructor(private readonly directory: string) {
        this.append(`Начало: ${this.startedAt.toISOString()}\n`);
    }

    public append(text: string): void {
        this.chunks.push(text);
    }

    public async save(): Promise<void> {
        await mkdir(this.directory, { recursive: true });

        const timestamp = this.startedAt
            .toISOString()
            .replace(/[:.]/g, "-");

        const filePath = path.join(
            this.directory,
            `${timestamp}-${randomUUID()}.log`
        );

        await writeFile(filePath, this.chunks.join(""), {
            encoding: "utf8",
            flag: "wx"
        });
    }
}

function runProcess(
    executable: string,
    args: string[],
    output: vscode.OutputChannel,
    showOutput: boolean = true,
    log?: RunLog
): Promise<number> {
    log?.append(
        `\nКоманда: ${JSON.stringify([executable, ...args])}\n`
    );

    return new Promise((resolve, reject) => {
        const child = spawn(executable, args);

        let capturedOutput = "";

        const handleData = (data: Buffer): void => {
            const text = data.toString();

            capturedOutput += text;
            log?.append(text);

            if (showOutput) {
                output.append(text);
            }
        };

        child.stdout.on("data", handleData);
        child.stderr.on("data", handleData);

        child.on("error", (error: Error) => {
            log?.append(`\nОшибка запуска: ${error.message}\n`);
            reject(error);
        });

        child.on("close", (code, signal) => {
            log?.append(
                `\nЗавершение: код=${code}, сигнал=${signal ?? "нет"}\n`
            );

            if (signal) {
                reject(
                    new Error(`${executable} завершён сигналом ${signal}`)
                );
                return;
            }

            if (!showOutput && code !== 0 && capturedOutput) {
                output.append(capturedOutput);
            }

            resolve(code ?? 1);
        });
    });
}

async function showTestReport(
    reportPath: string,
    output: vscode.OutputChannel
): Promise<boolean> {
    const xml = await readFile(reportPath, "utf8");

    if (XMLValidator.validate(xml) !== true) {
        throw new Error("CTest создал некорректный XML-отчёт.");
    }

    const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: "",
        parseTagValue: false,
        isArray: (name) => name === "testcase"
    });

    const report = parser.parse(xml);
    const suite = report.testsuite;

    if (!suite || !Array.isArray(suite.testcase)) {
        throw new Error("В отчёте CTest отсутствует список тестов.");
    }

    const tests = suite.testcase;

    if (tests.length === 0) {
        throw new Error("Тесты не найдены.");
    }

    let problemCount = 0;

    for (const test of tests) {
        const failed =
            test.failure !== undefined ||
            test.error !== undefined;

        const skipped =
            test.skipped !== undefined ||
            test.status === "notrun" ||
            test.status === "disabled";

        if (!failed && !skipped) {
            continue;
        }

        problemCount++;

        output.appendLine(
            `${skipped ? "Не выполнен" : "Провален"}: ${test.name}`
        );

        const testOutput = test["system-out"];

        const text = typeof testOutput === "string"
            ? testOutput
            : testOutput?.["#text"];

        if (typeof text === "string" && text.trim()) {
            output.appendLine(text.trim());
        }

        output.appendLine("");
    }

    if (problemCount === 0) {
        output.appendLine(`Все тесты прошли! Всего: ${tests.length}`);
    } else {
        output.appendLine(
            `Всего: ${tests.length}. С проблемами: ${problemCount}.`
        );
    }

    return problemCount === 0;
}

export function activate(context: vscode.ExtensionContext): void {
    const output = vscode.window.createOutputChannel(
        "C++ Test Runner"
    );

    const diagnostics = vscode.window.createOutputChannel(
        "C++ Test Runner Diagnostics"
    );

    context.subscriptions.push(output, diagnostics);

    const settingsCommand = vscode.commands.registerCommand(
        "cppTestRunner.openSettings",
        async () => {
            await vscode.commands.executeCommand(
                "workbench.action.openSettings",
                "cppTestRunner"
            );
        }
    );

    context.subscriptions.push(settingsCommand);

    let isRunning = false;

    const command = vscode.commands.registerCommand(
        "cppTestRunner.runTests",
        async () => {
            if (isRunning) {
                vscode.window.showInformationMessage(
                    "Тесты уже выполняются."
                );
                return;
            }

            const workspaceFolder =
                vscode.workspace.workspaceFolders?.[0];

            if (!workspaceFolder) {
                vscode.window.showErrorMessage(
                    "Сначала открой папку проекта."
                );
                return;
            }

            isRunning = true;
            let log: RunLog | undefined;

            output.clear();
            diagnostics.clear();

            try {
                const config = vscode.workspace.getConfiguration(
                    "cppTestRunner",
                    workspaceFolder.uri
                );

                if (config.get<boolean>("logs.enabled", false)) {
                    const directory = config
                        .get<string>("logs.directory", "")
                        .trim();

                    if (!directory) {
                        vscode.window.showErrorMessage(
                            "Укажи папку в настройке Logs: Directory."
                        );
                        return;
                    }

                    log = new RunLog(
                        path.resolve(
                            workspaceFolder.uri.fsPath,
                            directory
                        )
                    );

                    log.append(
                        `Проект: ${workspaceFolder.uri.fsPath}\n`
                    );
                }

                const cacheFiles = await vscode.workspace.findFiles(
                    new vscode.RelativePattern(
                        workspaceFolder,
                        "**/CMakeCache.txt"
                    ),
                    "**/{node_modules,.git}/**"
                );

                if (cacheFiles.length === 0) {
                    const sourceDirectory = workspaceFolder.uri.fsPath;

                    const cmakeLists = vscode.Uri.joinPath(
                        workspaceFolder.uri,
                        "CMakeLists.txt"
                    );

                    try {
                        await vscode.workspace.fs.stat(cmakeLists);
                    } catch {
                        throw new Error(
                            "Открой папку C++ проекта с CMakeLists.txt в корне."
                        );
                    }

                    const newBuildDirectory = path.join(
                        sourceDirectory,
                        "build"
                    );

                    const configureCode = await runProcess(
                        "cmake",
                        [
                            "-S", sourceDirectory,
                            "-B", newBuildDirectory
                        ],
                        output,
                        false,
                        log
                    );

                    if (configureCode !== 0) {
                        throw new Error(
                            `Настройка CMake завершилась с кодом ${configureCode}.`
                        );
                    }

                    cacheFiles.push(
                        vscode.Uri.file(
                            path.join(
                                newBuildDirectory,
                                "CMakeCache.txt"
                            )
                        )
                    );
                }

                const buildDirectories = cacheFiles
                    .map((file) => path.dirname(file.fsPath))
                    .sort();

                let buildDirectory: string;

                if (buildDirectories.length === 1) {
                    buildDirectory = buildDirectories[0]!;
                } else {
                    const selected =
                        await vscode.window.showQuickPick(
                            buildDirectories.map((directory) => ({
                                label: path.relative(
                                    workspaceFolder.uri.fsPath,
                                    directory
                                ) || ".",
                                description: directory
                            })),
                            {
                                placeHolder:
                                    "Выбери каталог сборки CMake"
                            }
                        );

                    if (!selected) {
                        log?.append("Выбор сборки отменён.\n");
                        return;
                    }

                    buildDirectory = selected.description;
                }

                log?.append(`Сборка: ${buildDirectory}\n`);
                output.show(true);

                const buildCode = await runProcess(
                    "cmake",
                    ["--build", buildDirectory],
                    output,
                    false,
                    log
                );

                if (buildCode !== 0) {
                    throw new Error(
                        `Сборка завершилась с кодом ${buildCode}. Тесты не запущены.`
                    );
                }

                const reportPath = path.join(
                    buildDirectory,
                    "test-results.xml"
                );

                await rm(reportPath, { force: true });

                const testCode = await runProcess(
                    "ctest",
                    [
                        "--test-dir", buildDirectory,
                        "--output-on-failure",
                        "--no-tests=error",
                        "--output-junit", reportPath
                    ],
                    diagnostics,
                    true,
                    log
                );

                try {
                    const allPassed = await showTestReport(
                        reportPath,
                        output
                    );

                    if (testCode !== 0 && allPassed) {
                        output.appendLine(
                            `CTest завершился с кодом ${testCode}. См. Diagnostics.`
                        );

                        diagnostics.show(true);
                    }
                } catch (error) {
                    diagnostics.show(true);
                    throw error;
                }
            } catch (error: unknown) {
                const message = error instanceof Error
                    ? error.message
                    : String(error);

                log?.append(`\nОшибка: ${message}\n`);

                output.appendLine(`Ошибка: ${message}`);
                output.show(true);
            } finally {
                try {
                    if (log) {
                        log.append(
                            `\nКонец: ${new Date().toISOString()}\n`
                        );

                        await log.save();
                    }
                } catch (error: unknown) {
                    const message = error instanceof Error
                        ? error.message
                        : String(error);

                    vscode.window.showErrorMessage(
                        `Не удалось сохранить лог: ${message}`
                    );
                } finally {
                    isRunning = false;
                }
            }
        }
    );

    context.subscriptions.push(command);

    const runButton = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Left,
        100
    );

    runButton.text = "$(play) C++ Tests";
    runButton.tooltip = "Запустить C++ тесты";
    runButton.command = "cppTestRunner.runTests";
    runButton.show();

    context.subscriptions.push(runButton);
}