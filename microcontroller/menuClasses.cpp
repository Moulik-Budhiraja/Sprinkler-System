#include "MenuClasses.h"

extern LiquidCrystal lcd;

MenuOption::MenuOption(String name, void (*action)())
    : name(name), action(action) {}

Menu::Menu(String title) : title(title), currentOption(0) {}

void Menu::addOption(MenuOption* option) { options.add(option); }

void Menu::nextOption() {
    currentOption = (currentOption + 1) % options.size();
    display();
}

void Menu::prevOption() {
    currentOption = (currentOption - 1 + options.size()) % options.size();
    display();
}

String Menu::getCurrent() { return options.get(currentOption)->name; }

void Menu::activateOption() { options.get(currentOption)->action(); }

void Menu::display() {
    lcd.setCursor(0, 0);
    lcd.print(centreString(title, 16));
    lcd.setCursor(0, 1);
    lcd.print(centreString(options.get(currentOption)->name, 16));
}

void MenuManager::pushMenu(Menu* menu) {
    if (menuStack.size() > 0) {
        selectHistory.add(menuStack.get(menuStack.size() - 1)->getCurrent());
    }

    menuStack.add(menu);
    menu->display();
}

void MenuManager::popMenu() {
    if (menuStack.size() > 0) {
        menuStack.remove(menuStack.size() - 1);
        Serial.println(selectHistory.size());
        Serial.println(selectHistory.get(selectHistory.size() - 1));

        selectHistory.remove(selectHistory.size() - 1);

        if (menuStack.size() > 0) {
            menuStack.get(menuStack.size() - 1)->display();
        }
    }
}

void MenuManager::nextOption() {
    if (menuStack.size() > 0) {
        menuStack.get(menuStack.size() - 1)->nextOption();
    }
}

void MenuManager::prevOption() {
    if (menuStack.size() > 0) {
        menuStack.get(menuStack.size() - 1)->prevOption();
    }
}

void MenuManager::activateOption() {
    if (menuStack.size() > 0) {
        menuStack.get(menuStack.size() - 1)->activateOption();
    }
}

void MenuManager::clear() {
    menuStack.clear();
    selectHistory.clear();
}

LinkedList<String>* MenuManager::getSelectHistory() { return &selectHistory; }

Menu* MenuManager::getCurrentMenu() {
    if (menuStack.size() > 0) {
        return menuStack.get(menuStack.size() - 1);
    } else {
        return NULL;
    }
}