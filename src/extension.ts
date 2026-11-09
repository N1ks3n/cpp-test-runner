import * as vscode from "vscode";
import { spawn } from "node:child_process";
import * as path from "node:path";

export function activate(context: vscode.ExtensionContext): void {
    const output = vscode.window.createOutputChannel("C++ Test Runner");
    context.subscriptions.push(output);

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
                vscode.window.showErrorMessage(
                    "Сборки CMake не найдены. Сначала выполни настройку проекта через cmake."
                );
                return;
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
            output.appendLine(`Каталог сборки: ${buildDirectory}`);

            isRunning = true;

            const process = spawn("ctest", [
                "--test-dir",
                buildDirectory,
                "--output-on-failure",
                "--no-tests=error"
            ]);

            process.stdout.on("data", (data: Buffer) => {
                output.append(data.toString());
            });

            process.stderr.on("data", (data: Buffer) => {
                output.append(data.toString());
            });

            process.on("error", (error: Error) => {
                output.appendLine(`Не удалось запустить CTest: ${error.message}`);
            });

            process.on("close", (code, signal) => {
                isRunning = false;

                if (signal) {
                    output.appendLine(`CTest завершён сигналом: ${signal}`);
                } else if (code !== null) {
                    output.appendLine(`CTest завершился с кодом: ${code}`);
                }
            });
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