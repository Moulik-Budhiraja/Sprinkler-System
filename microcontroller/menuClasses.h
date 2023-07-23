#ifndef MENU_CLASSES_H
#define MENU_CLASSES_H

#include <Arduino.h>
#include <LinkedList.h>
#include <LiquidCrystal.h>

#include "helpers.h"

class MenuOption {
   public:
    const String name;
    void (*action)();

    MenuOption(String name, void (*action)());
};

class Menu {
   private:
    LinkedList<MenuOption*> options;
    int currentOption;
    const String title;

   public:
    Menu(String title);
    void addOption(MenuOption* option);
    void nextOption();
    void prevOption();
    String getCurrent();
    void activateOption();
    void display();
};

class MenuManager {
   private:
    LinkedList<Menu*> menuStack;
    LinkedList<String> selectHistory;

   public:
    void pushMenu(Menu* menu);
    void popMenu();
    void nextOption();
    void prevOption();
    void activateOption();
    void clear();
    LinkedList<String>* getSelectHistory();
    Menu* getCurrentMenu();
};

#endif