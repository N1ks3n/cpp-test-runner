import * as vscode from "vscode";
import { spawn } from "node:child_process";
import * as path from "node:path";
import { readFile, rm } from "node:fs/promises";
import { XMLParser, XMLValidator } from "fast-xml-parser";

function runProcess(
    executable: string,
    args: string[],
    output: vscode.OutputChannel,
    showOutput: boolean = true
): Promise<number> {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args);

        let capturedOutput = "";

        child.stdout.on("data", (data: Buffer) => {
            const text = data.toString();
            capturedOutput += text;

            if (showOutput) {
                output.append(text);
            }
        });

        child.stderr.on("data", (data: Buffer) => {
            const text = data.toString();
            capturedOutput += text;

            if (showOutput) {
                output.append(text);
            }
        });

        child.on("error", reject);

        child.on("close", (code, signal) => {
            if (signal) {
                reject(
                    new Error(`${executable} завершён сигналом ${signal}`)
                );
                return;
            }

            if (!showOutput && code !== 0 && capturedOutput.length > 0) {
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
    const output = vscode.window.createOutputChannel("C++ Test Runner");
    context.subscriptions.push(output);

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
                vscode.window.showInformationMessage("Тесты уже выполняются.");
                return;
            }

            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

            if (!workspaceFolder) {
                vscode.window.showErrorMessage("Сначала открой папку проекта.");
                return;
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
                    vscode.window.showErrorMessage(
                        "Открой папку C++ проекта с CMakeLists.txt в корне."
                    );
                    return;
                }

                const newBuildDirectory = path.join(
                    sourceDirectory,
                    "build"
                );

                output.clear();
                output.show(true);
                output.appendLine("Настройка новой сборки CMake...");

                isRunning = true;

                try {
                    const configureCode = await runProcess(
                        "cmake",
                        [
                            "-S", sourceDirectory,
                            "-B", newBuildDirectory
                        ],
                        output
                    );

                    if (configureCode !== 0) {
                        output.appendLine(
                            `Настройка CMake завершилась с кодом ${configureCode}.`
                        );
                        return;
                    }

                    cacheFiles.push(
                        vscode.Uri.file(
                            path.join(newBuildDirectory, "CMakeCache.txt")
                        )
                    );
                } catch (error: unknown) {
                    const message = error instanceof Error
                        ? error.message
                        : String(error);

                    output.appendLine(`Ошибка настройки CMake: ${message}`);
                    return;
                } finally {
                    isRunning = false;
                }
            }

            const buildDirectories = cacheFiles
                .map((file) => path.dirname(file.fsPath))
                .sort();

            let buildDirectory: string;

            if (buildDirectories.length === 1) {
                buildDirectory = buildDirectories[0]!;
            } else {
                const selected = await vscode.window.showQuickPick(
                    buildDirectories.map((directory) => ({
                        label: path.relative(
                            workspaceFolder.uri.fsPath,
                            directory
                        ) || ".",
                        description: directory
                    })),
                    {
                        placeHolder: "Выбери каталог сборки CMake"
                    }
                );

                if (!selected) {
                    return;
                }

                buildDirectory = selected.description;
            }

            output.clear();
            output.show(true);

            isRunning = true;

            const diagnostics = vscode.window.createOutputChannel(
                "C++ Test Runner Diagnostics"
            );

            try {
                const buildCode = await runProcess(
                    "cmake",
                    ["--build", buildDirectory],
                    output,
                    false
                );

                if (buildCode !== 0) {
                    output.appendLine(
                        `Сборка завершилась с кодом ${buildCode}. Тесты не запущены.`
                    );
                    return;
                }

                const reportPath = path.join(
                    buildDirectory,
                    "test-results.xml"
                );

                await rm(reportPath, { force: true });

                const testCode = await runProcess(
                    "ctest",
                    [
                        "--test-dir",
                        buildDirectory,
                        "--output-on-failure",
                        "--no-tests=error",
                        "--output-junit",
                        reportPath
                    ],
                    diagnostics
                );

                try {
                    const allPassed = await showTestReport(reportPath, output);

                    if (testCode !== 0 && allPassed) {
                        output.appendLine(
                            `CTest завершился с кодом ${testCode}. Подробности:`
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

                output.appendLine(`Ошибка: ${message}`);
            } finally {
                isRunning = false;
                context.subscriptions.push(diagnostics);
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