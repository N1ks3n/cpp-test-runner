import * as vscode from "vscode";
import { spawn } from "node:child_process";
import * as path from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { XMLParser, XMLValidator } from "fast-xml-parser";

import {
    saveRun,
    showStatistics,
    type TestSummary
} from "./statistics.js";

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
            .replace("T", "_")
            .replace(/:/g, "-")
            .replace(".", "-")
            .replace("Z", "");

        await writeFile(
            path.join(this.directory, `${timestamp}.log`),
            this.chunks.join(""),
            {
                encoding: "utf8",
                flag: "wx"
            }
        );
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

// Узлы XML могут содержать строку либо объект с текстом и атрибутами.
function xmlText(value: unknown): string {
    if (typeof value === "string") {
        return value.trim();
    }

    if (typeof value === "number") {
        return String(value);
    }

    if (Array.isArray(value)) {
        return value.map(xmlText).filter(Boolean).join("\n");
    }

    if (value && typeof value === "object") {
        const node = value as Record<string, unknown>;
        const parts = [
            xmlText(node.message),
            xmlText(node["#text"])
        ];

        return [...new Set(parts.filter(Boolean))].join("\n");
    }

    return "";
}

async function showTestReport(
    reportPath: string,
    output: vscode.OutputChannel
): Promise<TestSummary> {
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

    let failedCount = 0;
    let skippedCount = 0;

    for (const test of tests) {
        const status = String(test.status ?? "").toLowerCase();

        // Тайм-аут, аварийное завершение и ошибка проверки —
        // неуспешные тесты, а не пропуски.
        const failed =
            test.failure !== undefined ||
            test.error !== undefined ||
            status === "fail" ||
            status === "failed";

        const skipped = !failed && (
            test.skipped !== undefined ||
            status === "notrun" ||
            status === "disabled" ||
            status === "skipped"
        );

        if (failed) {
            failedCount++;
        } else if (skipped) {
            skippedCount++;
        } else {
            continue;
        }

        output.appendLine(
            `${failed ? "Провален" : "Пропущен"}: ${test.name}`
        );

        const reason = failed
            ? xmlText(test.failure) || xmlText(test.error)
            : xmlText(test.skipped);

        const details = [
            reason,
            xmlText(test["system-out"]),
            xmlText(test["system-err"])
        ];

        for (const text of new Set(details.filter(Boolean))) {
            output.appendLine(text);
        }

        output.appendLine("");
    }

    const summary: TestSummary = {
        total: tests.length,
        passed: tests.length - failedCount - skippedCount,
        failed: failedCount,
        skipped: skippedCount
    };

    if (failedCount === 0 && skippedCount === 0) {
        output.appendLine(
            `Все тесты прошли! Всего: ${summary.total}`
        );
    } else {
        output.appendLine(
            `Всего: ${summary.total}. ` +
            `Успешно: ${summary.passed}. ` +
            `Провалено: ${summary.failed}.`
        );
    }

    return summary;
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

    const statisticsCommand = vscode.commands.registerCommand(
        "cppTestRunner.showStatistics",
        async () => {
            try {
                await showStatistics(context);
            } catch (error: unknown) {
                const message = error instanceof Error
                    ? error.message
                    : String(error);

                vscode.window.showErrorMessage(
                    `Не удалось открыть статистику: ${message}`
                );
            }
        }
    );

    context.subscriptions.push(settingsCommand, statisticsCommand);

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

                const parallelJobs = config.get<number>(
                    "tests.parallelJobs",
                    1
                );

                const timeoutSeconds = config.get<number>(
                    "tests.timeoutSeconds",
                    60
                );

                const historyLimit = config.get<number>(
                    "statistics.historyLimit",
                    100
                );

                if (
                    !Number.isInteger(parallelJobs) ||
                    parallelJobs < 1
                ) {
                    throw new Error(
                        "Tests: Parallel Jobs должно быть целым числом не меньше 1."
                    );
                }

                if (
                    !Number.isFinite(timeoutSeconds) ||
                    timeoutSeconds <= 0
                ) {
                    throw new Error(
                        "Tests: Timeout Seconds должно быть положительным числом."
                    );
                }

                if (
                    !Number.isInteger(historyLimit) ||
                    historyLimit < 1 ||
                    historyLimit > 1000
                ) {
                    throw new Error(
                        "Statistics: History Limit должно быть целым числом от 1 до 1000."
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
                    const sourceDirectory =
                        workspaceFolder.uri.fsPath;

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

                const startedAt = new Date();
                const startedTimer = performance.now();

                const testCode = await runProcess(
                    "ctest",
                    [
                        "--test-dir", buildDirectory,
                        "--output-on-failure",
                        "--no-tests=error",
                        "--parallel", String(parallelJobs),
                        "--timeout", String(timeoutSeconds),
                        "--output-junit", reportPath
                    ],
                    diagnostics,
                    true,
                    log
                );

                const durationMs = performance.now() - startedTimer;

                let summary: TestSummary;

                try {
                    summary = await showTestReport(
                        reportPath,
                        output
                    );

                    const allPassed =
                        summary.failed === 0 &&
                        summary.skipped === 0;

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

                try {
                    await saveRun(
                        context,
                        workspaceFolder,
                        {
                            date: startedAt.toISOString(),
                            buildDirectory,
                            durationMs,
                            exitCode: testCode,
                            ...summary
                        },
                        historyLimit
                    );
                } catch (error: unknown) {
                    const message = error instanceof Error
                        ? error.message
                        : String(error);

                    log?.append(
                        `\nОшибка сохранения статистики: ${message}\n`
                    );

                    vscode.window.showWarningMessage(
                        `Тесты завершены, но статистика не сохранена: ${message}`
                    );
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