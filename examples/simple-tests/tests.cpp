#include <iostream>
#include <string>

int main(int argc, char* argv[]) {
    if (argc != 2) {
        std::cerr << "Expected one test name\n";
        return 1;
    }

    const std::string testName = argv[1];

    if (testName == "addition") {
        if (2 + 2 != 4) {
            std::cerr << "Expected 2 + 2 to equal 4\n";
            return 1;
        }

        return 0;
    }

    if (testName == "subtraction") {
        const int actual = 5 - 3;
        const int expected = 3; // Намеренно неверное ожидание.

        if (actual != expected) {
            std::cerr
                << "Expected " << expected
                << ", got " << actual << '\n';

            return 1;
        }

        return 0;
    }

    std::cerr << "Unknown test: " << testName << '\n';
    return 1;
}