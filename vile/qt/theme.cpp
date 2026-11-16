#include "theme.h"

#include "uisettings.h"

const std::vector<Accent>& accents() {
    static const std::vector<Accent> list = {
        {QStringLiteral("violet"), QStringLiteral("Violet"),
         QStringLiteral("#7c2bf5"), QStringLiteral("#9759ff"),
         QStringLiteral("#a06bff"), QStringLiteral("#8f42ff")},
    };
    return list;
}

Accent accentById(const QString& id) {
    for (const auto& a : accents())
        if (a.id == id) return a;
    return accents().front();
}

// Designated initializers (C++20): the compiler now ties every
// value to its field NAME, so inserting a field into the struct
// can't silently shift two roles in one palette — round 13's
// architect flagged the positional lists as guarded by nothing.
// Layered neutrals with a faint cool tint (the user's palette
// revision, 2026-11-12): the window frame is the darkest layer,
// toolbars sit one step up, and content/panels one more, so depth
// comes from tone instead of borders.
const Palette& darkPalette() {
    static const Palette p = {
        .bg = QStringLiteral("#131316"),
        .bgDeep = QStringLiteral("#0c0c0f"),
        .chrome = QStringLiteral("#1a1a1f"),
        .surface = QStringLiteral("#1c1c21"),
        .well = QStringLiteral("#18181c"),
        .tabList = QStringLiteral("#0f0f12"),
        .button = QStringLiteral("#222228"),
        .btnHover = QStringLiteral("#2c2c34"),
        .railHover = QStringLiteral("#212127"),
        .pressed = QStringLiteral("#34343d"),
        .raised = QStringLiteral("#26262d"),
        .track = QStringLiteral("#2b2b33"),
        .vertItem = QStringLiteral("#19191e"),
        .bookmarkWash = QStringLiteral("#2e2e35"),
        .option = QStringLiteral("#212127"),
        .optionSelected = QStringLiteral("#2f2a4a"),
        .border = QStringLiteral("#26262d"),
        .cardBorder = QStringLiteral("#25252c"),
        .borderStrong = QStringLiteral("#34343d"),
        .hoverBorder = QStringLiteral("#44444e"),
        .indicator = QStringLiteral("#6e6e7a"),
        .scroll = QStringLiteral("#34343d"),
        .scrollHover = QStringLiteral("#4a4a55"),
        .scrollBg = QStringLiteral("#131316"),
        .text = QStringLiteral("#e8e8ee"),
        .bright = QStringLiteral("#ffffff"),
        .buttonText = QStringLiteral("#dcdce3"),
        .tabText = QStringLiteral("#cdcdd6"),
        .secondary = QStringLiteral("#a8a8b4"),
        .muted = QStringLiteral("#8c8c98"),
        .faint = QStringLiteral("#72727e"),
        .disabled = QStringLiteral("#5c5c68"),
        .groupText = QStringLiteral("#c2c2cc"),
        .accentText = QStringLiteral("#b79cff"),
        .selected = QStringLiteral("#2c2552"),
        .selectedSoft = QStringLiteral("#272145"),
        .dangerBg = QStringLiteral("#3a2326"),
        .dangerBorder = QStringLiteral("#6e3438"),
        .dangerText = QStringLiteral("#e89094"),
        .dangerBgHover = QStringLiteral("#4a2b2f"),
        .dangerBorderHover = QStringLiteral("#7d3c42"),
        .dangerTextHover = QStringLiteral("#f0a8ac"),
        .isLight = false,
    };
    return p;
}

const Palette& lightPalette() {
    static const Palette p = {
        .bg = QStringLiteral("#f6f6f9"),
        .bgDeep = QStringLiteral("#e6e6ec"),
        .chrome = QStringLiteral("#eceef3"),
        .surface = QStringLiteral("#ffffff"),
        .well = QStringLiteral("#f0f0f5"),
        .tabList = QStringLiteral("#e4e4eb"),
        .button = QStringLiteral("#ffffff"),
        .btnHover = QStringLiteral("#e8e8f0"),
        .railHover = QStringLiteral("#e4e4ec"),
        .pressed = QStringLiteral("#dcdce5"),
        .raised = QStringLiteral("#e6e6ee"),
        .track = QStringLiteral("#e3e3eb"),
        .vertItem = QStringLiteral("#e8e8ef"),
        .bookmarkWash = QStringLiteral("#e2e2ea"),
        .option = QStringLiteral("#ffffff"),
        .optionSelected = QStringLiteral("#ece3fd"),
        .border = QStringLiteral("#dcdce4"),
        .cardBorder = QStringLiteral("#e0e0e8"),
        .borderStrong = QStringLiteral("#c8c8d2"),
        .hoverBorder = QStringLiteral("#a8a8b6"),
        .indicator = QStringLiteral("#a3a3b0"),
        .scroll = QStringLiteral("#c8c8d2"),
        .scrollHover = QStringLiteral("#b2b2be"),
        .scrollBg = QStringLiteral("#e6e6ec"),
        .text = QStringLiteral("#1b1b22"),
        .bright = QStringLiteral("#0d0d12"),
        .buttonText = QStringLiteral("#26262e"),
        .tabText = QStringLiteral("#3f3f4a"),
        .secondary = QStringLiteral("#52525e"),
        .muted = QStringLiteral("#62626f"),
        .faint = QStringLiteral("#8b8b98"),
        .disabled = QStringLiteral("#acacb8"),
        .groupText = QStringLiteral("#3f3f4a"),
        .accentText = QStringLiteral("#6d28d9"),
        .selected = QStringLiteral("#e1d6fc"),
        .selectedSoft = QStringLiteral("#efe8fd"),
        .dangerBg = QStringLiteral("#fbeeef"),
        .dangerBorder = QStringLiteral("#e2a9ad"),
        .dangerText = QStringLiteral("#b03a42"),
        .dangerBgHover = QStringLiteral("#f6dddf"),
        .dangerBorderHover = QStringLiteral("#d69599"),
        .dangerTextHover = QStringLiteral("#a02f37"),
        .isLight = true,
    };
    return p;
}

const Palette& paletteById(const QString& id) {
    return id == QStringLiteral("light") ? lightPalette() : darkPalette();
}

const Palette& activePalette() { return paletteById(uiSettings().theme()); }

QString appStyleSheet(const Accent& accent, const Palette& p) {
    // The stylesheet is written with @role@ tokens; this is the one
    // place they resolve. Accent tokens come from the Accent struct,
    // surface tokens from the Palette.
    QString sheet = QStringLiteral(R"(
        QMainWindow, QDialog, QWidget { background: @bg@; color: @text@; }
        QMenuBar { background: @bg@; color: @secondary@; border-bottom: 1px solid @border@; padding: 2px 6px; font-size: 12px; }
        QMenuBar::item { padding: 4px 10px; border-radius: 6px; }
        QMenuBar::item:selected, QMenu::item:selected { background: @raised@; color: @bright@; }
        QMenu { background: @surface@; border: 1px solid @border@; padding: 6px; color: @bright@; }
        QMenu::item { padding: 6px 26px 6px 10px; border-radius: 6px; }
        QMenu::separator { height: 1px; background: @border@; margin: 4px 8px; }
        QToolBar#navigationBar { background: @chrome@; border: none; border-bottom: 1px solid @border@; spacing: 6px; padding: 8px 10px; }
        QToolBar#tabBar { background: @tablist@; border: none; spacing: 4px; padding: 4px 6px 0 6px; }
        QToolBar#bookmarkBar { background: @chrome@; border: none; border-bottom: 1px solid @border@; spacing: 2px; padding: 3px 8px; }
        QPushButton#bookmarkChip { background: transparent; border: none; border-radius: 6px; color: @text@; font-size: 12px; padding: 3px 8px; text-align: left; }
        QPushButton#bookmarkChip:hover { background: @railhover@; }
        QToolBar#utilityRail { background: @bgdeep@; border: none; border-right: 1px solid @border@; padding: 10px 6px; spacing: 6px; }
        QToolBar#utilityRail QToolButton { background: transparent; border: 1px solid transparent; border-radius: 8px; color: @muted@; font-size: 10px; min-width: 54px; min-height: 42px; padding: 4px 3px 3px; }
        QToolBar#utilityRail QToolButton:hover { background: @railhover@; color: @text@; }
        QToolBar#utilityRail QToolButton:checked { background: @selectedsoft@; border-color: @border@; color: @bright@; }
        QToolButton, QPushButton { background: @button@; color: @buttontext@; border: 1px solid @borderstrong@; border-radius: 8px; padding: 6px 10px; }
        QToolButton:hover, QPushButton:hover { background: @btnhover@; border-color: @hoverborder@; color: @bright@; }
        QToolButton:pressed, QPushButton:pressed { background: @pressed@; }
        QPushButton#navButton { background: transparent; border: none; border-radius: 8px; padding: 0; }
        QPushButton#navButton:hover { background: @btnhover@; border: none; }
        QPushButton#navButton:disabled { background: transparent; border: none; }
        QToolButton:disabled, QPushButton:disabled { background: transparent; border: 1px solid @border@; color: @disabled@; }
        QPushButton#primaryAction { background: @primary@; border-color: @light@; color: white; font-weight: 600; padding: 7px 12px; }
        QPushButton#primaryAction:hover { background: @hover@; }
        QPushButton#primaryAction:disabled { background: @raised@; color: @indicator@; border-color: @borderstrong@; }
        QPushButton#secondaryAction:disabled { background: @vertitem@; border: 1px solid @border@; color: @disabled@; }
        QPushButton#dangerButton { background: @dangerbg@; border: 1px solid @dangerborder@; color: @dangertext@; font-weight: 600; }
        QPushButton#dangerButton:hover { background: @dangerbghover@; border-color: @dangerborderhover@; color: @dangertexthover@; }
        QPushButton#zoomChip { background: @raised@; border: 1px solid @border@; border-radius: 8px; color: @secondary@; padding: 4px 8px; }
        QPushButton#zoomChip:hover { color: @bright@; border-color: @hoverborder@; }
        QLineEdit { background: @bgdeep@; color: @bright@; border: 1px solid @borderstrong@; border-radius: 8px; padding: 8px 10px; selection-background-color: @primary@; }
        QLineEdit#addressBar { border-radius: 8px; padding: 9px 14px; }
        QLineEdit:focus { border: 1px solid @focus@; }
        QToolBar::separator { background: @borderstrong@; width: 1px; margin: 5px 3px; }
        QTabWidget::pane { background: @surface@; border: none; border-top: 1px solid @border@; border-radius: 0; top: 0; }
        QTabBar::tab { background: transparent; color: @muted@; border: none; border-bottom: 2px solid transparent; padding: 8px 12px; margin-right: 0; min-width: 0; }
        QTabBar::tab:selected { background: transparent; color: @bright@; border-bottom: 2px solid @focus@; }
        QTabBar::tab:hover:!selected { background: transparent; color: @tabtext@; }
        QListWidget#tabList { background: @tablist@; border: none; outline: 0; padding: 3px 0; }
        QListWidget#tabList[vertical="false"] { background: @chrome@; border-bottom: 1px solid @border@; }
        QListWidget#tabList[vertical="true"] { background: transparent; border: none; }
        QWidget#tabRail { background: @tablist@; border-right: 1px solid @border@; }
        QListWidget#tabList::item { border: none; margin: 3px 8px; border-radius: 8px; }
        QListWidget#tabList::item:selected { background: @selected@; }
        /* Vertical sidebar: every row gets the container the selected
           row's pill implies — inactive rows floating bare in the
           column read as unfinished next to it. */
        QListWidget#tabList[vertical="true"]::item { background: @vertitem@; }
        QListWidget#tabList[vertical="true"]::item:selected { background: @selected@; }
        QListWidget#bookmarkList { background: transparent; border: none; outline: 0; padding: 3px 0; }
        QListWidget#bookmarkList::item { border: none; margin: 3px 8px; border-radius: 8px; background: @bookmarkwash@; }
        QListWidget#bookmarkList::item:selected { background: @bookmarkwash@; }
        QLabel#tabTitle { color: @tabtext@; background: transparent; }
        QLabel#tabIcon { color: @focus@; background: transparent; font-size: 11px; font-weight: 700; }
        QLabel#tabDot { color: @focus@; font-size: 8px; background: transparent; }
        QLabel#sectionLabel { color: @faint@; font-size: 11px; font-weight: 700; letter-spacing: 1px; background: transparent; }
        QPushButton#tabClose { background: transparent; border: none; color: @muted@; padding: 0; border-radius: 4px; }
        QPushButton#tabClose:hover { background: @raised@; color: @bright@; }
        QWidget#suggestionPopup { background: @well@; border: 1px solid @borderstrong@; border-radius: 12px; }
        QListWidget#suggestionList { background: transparent; border: none; outline: 0; }
        QListWidget#suggestionList::item { padding: 5px 12px; border-radius: 8px; }
        QListWidget#suggestionList::item:selected { background: @raised@; }
        QLabel#wordmark { color: @muted@; font-size: 11px; font-weight: 700; letter-spacing: 2px; }
        QLabel#panelTitle { color: @text@; font-size: 13px; font-weight: 700; }
        QWidget#findBar { background: @surface@; border-top: 1px solid @cardborder@; }
        QWidget#downloadRow { background: @surface@; border: 1px solid @cardborder@; border-radius: 8px; }
        QWidget#entryRow { background: @surface@; border: 1px solid @cardborder@; border-radius: 8px; }
        QWidget#entryRow[selected="true"] { background: @selectedsoft@; border: 1px solid @primary@; }
        QListWidget#entryWell { background: @well@; border: 1px solid @border@; border-radius: 10px; padding: 6px; }
        QProgressBar { background: @track@; border: 1px solid @hoverborder@; border-radius: 3px; color: @text@; text-align: center; }
        QProgressBar::chunk { background: @focus@; border-radius: 3px; }
        QProgressBar#loadLine { background: transparent; border: none; }
        QProgressBar#loadLine::chunk { background: @focus@; border-radius: 0; }
        QFrame#statusCard { background: @raised@; border: 1px solid @cardborder@; border-radius: 12px; }
        QFrame#statusCard QLabel { background: transparent; }
QLabel#panelFoot { color: @faint@; font-size: 11px; background: transparent; padding-top: 6px; }
        QScrollBar:vertical { background: transparent; width: 10px; margin: 0; }
        QScrollBar::handle:vertical { background: @scroll@; border-radius: 5px; min-height: 24px; }
        QScrollBar::handle:vertical:hover { background: @scrollhover@; }
        QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical { height: 0; }
        QScrollBar::add-page:vertical, QScrollBar::sub-page:vertical { background: transparent; }
        QScrollBar:horizontal { background: transparent; height: 10px; margin: 0; }
        QScrollBar::handle:horizontal { background: @scroll@; border-radius: 5px; min-width: 24px; }
        QScrollBar::handle:horizontal:hover { background: @scrollhover@; }
        QScrollBar::add-line:horizontal, QScrollBar::sub-line:horizontal { width: 0; }
        QScrollBar::add-page:horizontal, QScrollBar::sub-page:horizontal { background: transparent; }
        QLabel { background: transparent; }
        QCheckBox { background: transparent; }
        QRadioButton { background: transparent; }
        QLabel#statusCardTitle { font-size: 16px; font-weight: 700; }
        QDockWidget { color: @text@; }
        QDockWidget::title { background: @chrome@; padding: 10px 12px; border-bottom: 1px solid @border@; font-weight: 600; }
        QDockWidget QWidget { background: @surface@; }
        QListWidget, QTextEdit, QComboBox { background: @bgdeep@; color: @buttontext@; border: 1px solid @cardborder@; border-radius: 12px; padding: 6px; }
        QDockWidget QListWidget { background: transparent; border: none; border-radius: 0; padding: 0; }
        QListWidget::item { padding: 6px; border-radius: 8px; }
        QListWidget::item:selected, QListWidget::item:hover { background: @raised@; }
        QListWidget#settingsNav { background: transparent; border: none; outline: 0; }
        QListWidget#settingsNav::item { padding: 9px 12px; border-radius: 8px; color: @secondary@; }
        QListWidget#settingsNav::item:selected { background: @selected@; color: @bright@; }
        QLabel#settingsTitle { font-size: 17px; font-weight: 700; }
        QLabel#settingsDesc { color: @secondary@; font-size: 12px; }
        QDialog#onboardingDialog { background: @bg@; }
        QLabel#onboardingEyebrow { color: @faint@; font-size: 11px; font-weight: 700; letter-spacing: 1px; }
        QProgressBar#onboardingProgressBar { background: @track@; border: none; border-radius: 3px; text-align: left; }
        QProgressBar#onboardingProgressBar::chunk { background: @primary@; border-radius: 3px; }
        QLabel#onboardingProgress { color: @muted@; font-size: 11px; }
        QLabel#onboardingTitle { color: @bright@; font-size: 23px; font-weight: 700; padding-top: 2px; }
        QLabel#onboardingDescription { color: @muted@; font-size: 12px; padding-bottom: 6px; }
        QLabel#onboardingShortcutHint { color: @faint@; font-size: 10px; padding: 0 8px; }
        QFrame#onboardingOption { background: @option@; border: 1px solid @cardborder@; border-radius: 12px; }
        QFrame#onboardingOption:hover { background: @btnhover@; border-color: @hoverborder@; }
        QFrame#onboardingOption[selected="true"] { background: @optionselected@; border: 1px solid @focus@; }
        QLabel#onboardingMark { background: transparent; color: @accenttext@; font-size: 15px; font-weight: 700; }
        QRadioButton#onboardingOptionTitle { background: transparent; color: @bright@; font-size: 13px; font-weight: 600; padding: 0; }
        QRadioButton#onboardingOptionTitle::indicator { width: 16px; height: 16px; border-radius: 8px; border: 1px solid @indicator@; background: transparent; }
        QRadioButton#onboardingOptionTitle::indicator:checked { background: @primary@; border: 1px solid @primary@; }
        QLabel#onboardingOptionSummary { background: transparent; color: @muted@; font-size: 11px; }
        QPushButton#secondaryAction { background: transparent; border: 1px solid @border@; color: @secondary@; }
        QPushButton#secondaryAction:hover { background: @option@; color: @bright@; border-color: @borderstrong@; }
        QGroupBox { border: 1px solid @cardborder@; border-radius: 8px; margin-top: 14px; padding: 14px 12px 12px; font-weight: 600; color: @grouptext@; }
        QGroupBox::title { subcontrol-origin: margin; left: 12px; padding: 0 6px; background: @bg@; color: @faint@; font-size: 11px; font-weight: 700; }
        QLabel#settingsGroup { color: @faint@; font-size: 11px; font-weight: 700; letter-spacing: 1px; background: transparent; }
        QCheckBox, QRadioButton { spacing: 8px; padding: 4px 2px; }
        QRadioButton::indicator { width: 14px; height: 14px; border-radius: 7px; border: 1px solid @indicator@; background: transparent; }
        QRadioButton::indicator:checked { background: @primary@; border-color: @primary@; }
        QCheckBox::indicator { width: 15px; height: 15px; border-radius: 4px; border: 1px solid @indicator@; background: transparent; }
        QCheckBox::indicator:checked { background: @primary@; border-color: @primary@; image: url(:/assets/check.png); }
        QStatusBar { background: @bgdeep@; color: @muted@; border-top: 1px solid @border@; }
        QLabel#mutedLabel { color: @muted@; }
        QScrollBar:vertical { background: @scrollbg@; width: 11px; margin: 2px; }
        QScrollBar::handle:vertical { background: @scroll@; border-radius: 5px; min-height: 24px; }
        QScrollBar::handle:vertical:hover { background: @scrollhover@; }
    )");

    const std::pair<const char*, const QString*> roles[] = {
        {"@primary@", &accent.primary}, {"@light@", &accent.light},
        {"@focus@", &accent.focus}, {"@hover@", &accent.hover},
        {"@bg@", &p.bg}, {"@bgdeep@", &p.bgDeep}, {"@chrome@", &p.chrome},
        {"@surface@", &p.surface}, {"@well@", &p.well}, {"@tablist@", &p.tabList},
        {"@button@", &p.button}, {"@btnhover@", &p.btnHover},
        {"@railhover@", &p.railHover}, {"@pressed@", &p.pressed},
        {"@raised@", &p.raised}, {"@track@", &p.track}, {"@vertitem@", &p.vertItem}, {"@bookmarkwash@", &p.bookmarkWash},
        {"@option@", &p.option}, {"@optionselected@", &p.optionSelected},
        {"@border@", &p.border}, {"@cardborder@", &p.cardBorder},
        {"@borderstrong@", &p.borderStrong}, {"@hoverborder@", &p.hoverBorder},
        {"@indicator@", &p.indicator}, {"@scroll@", &p.scroll},
        {"@scrollhover@", &p.scrollHover}, {"@scrollbg@", &p.scrollBg},
        {"@text@", &p.text}, {"@bright@", &p.bright},
        {"@buttontext@", &p.buttonText}, {"@tabtext@", &p.tabText},
        {"@secondary@", &p.secondary}, {"@muted@", &p.muted}, {"@faint@", &p.faint},
        {"@disabled@", &p.disabled}, {"@grouptext@", &p.groupText},
        {"@accenttext@", &p.accentText}, {"@selected@", &p.selected},
        {"@selectedsoft@", &p.selectedSoft}, {"@dangerbg@", &p.dangerBg},
        {"@dangerborder@", &p.dangerBorder}, {"@dangertext@", &p.dangerText},
        {"@dangerbghover@", &p.dangerBgHover},
        {"@dangerborderhover@", &p.dangerBorderHover},
        {"@dangertexthover@", &p.dangerTextHover},
    };
    for (const auto& [token, value] : roles) sheet.replace(QLatin1String(token), *value);
    return sheet;
}
