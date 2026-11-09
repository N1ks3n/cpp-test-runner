import * as vscode from "vscode";
import { spawn } from "node:child_process";
import * as path from "node:path";

function runProcess(
    executable: string,
    args: string[],
    output: vscode.OutputChannel
): Promise<number> {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args);

        child.stdout.on("data", (data: Buffer) => {
            output.append(data.toString());
        });

        child.stderr.on("data", (data: Buffer) => {
            output.append(data.toString());
        });

        child.on("error", reject);

        child.on("close", (code, signal) => {
            if (signal) {
                reject(
                    new Error(`${executable} завершён сигналом ${signal}`)
                );
                return;
            }

            resolve(code ?? 1);
        });
    });
}

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
            output.appendLine(`Каталог сборки: ${buildDirectory}`);

            isRunning = true;

            try {
                output.appendLine("Сборка проекта...");

                const buildCode = await runProcess(
                    "cmake",
                    ["--build", buildDirectory],
                    output
                );

                if (buildCode !== 0) {
                    output.appendLine(
                        `Сборка завершилась с кодом ${buildCode}. Тесты не запущены.`
                    );
                    return;
                }

                output.appendLine("\nЗапуск тестов...");

                const testCode = await runProcess(
                    "ctest",
                    [
                        "--test-dir",
                        buildDirectory,
                        "--output-on-failure",
                        "--no-tests=error"
                    ],
                    output
                );

                output.appendLine(`CTest завершился с кодом: ${testCode}`);
            } catch (error: unknown) {
                const message = error instanceof Error
                    ? error.message
                    : String(error);

                output.appendLine(`Ошибка запуска: ${message}`);
            } finally {
                isRunning = false;
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