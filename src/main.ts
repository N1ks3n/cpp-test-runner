const extensionName: string = "C++ Test Runner";
const testsPassed: number = 3;
const testsFailed: number = 1;

console.log(extensionName);

if (testsFailed === 0) {
    console.log(`Все тесты прошли! Всего: ${testsPassed}`);
} else {
    console.log(`Провалено тестов: ${testsFailed}`);
}