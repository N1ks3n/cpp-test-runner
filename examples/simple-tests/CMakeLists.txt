cmake_minimum_required(VERSION 3.16)

project(SimpleTests LANGUAGES CXX)

enable_testing()

add_executable(example_tests tests.cpp)

target_compile_features(example_tests PRIVATE cxx_std_17)

add_test(
    NAME addition_passes
    COMMAND example_tests addition
)

add_test(
    NAME subtraction_fails
    COMMAND example_tests subtraction
)