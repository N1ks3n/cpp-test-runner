import * as vscode from "vscode";

export function activate(context: vscode.ExtensionContext): void {
    const command = vscode.commands.registerCommand(
        "cppTestRunner.runTests",
        () => {
            vscode.window.showInformationMessage(
                "C++ Test Runner готов к запуску тестов!"
            );
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