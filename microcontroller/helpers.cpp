#include "helpers.h"

String centreString(String inputStr, int totalLen) {
    int inputLen = inputStr.length();

    // checking if total length is less than the length of input string
    if (totalLen <= inputLen) {
        return inputStr;
    }

    // calculating the number of spaces to be padded
    int padLen = totalLen - inputLen;

    // calculating spaces to be padded on the left and right
    int leftPadLen = padLen / 2;
    int rightPadLen = padLen - leftPadLen;

    // creating strings with left and right padding
    String leftPad = "";
    String rightPad = "";

    for (int i = 0; i < leftPadLen; i++) {
        leftPad += " ";
    }
    for (int i = 0; i < rightPadLen; i++) {
        rightPad += " ";
    }

    // returning the string with padding
    return leftPad + inputStr + rightPad;
}

unsigned long getCurrentTime() {
    time_t now = time(nullptr);

    return (unsigned long)now;
}