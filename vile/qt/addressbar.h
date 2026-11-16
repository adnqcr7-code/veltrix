// The address bar as one component: the edit (with its Shield badge
// and bookmark star), the suggestions popup, and every behaviour
// that belongs to them — bang completion, history rows, keyboard
// navigation of the popup, the suppression dance when a suggestion
// is applied. Extracted from MainWindow in fix pass 8; before that
// the cluster's logic was spread across the constructor, three
// methods, and a branch of the window's event filter.
//
// The window keeps: navigation itself (it hears submitted()),
// bookmark toggling (bookmarkClicked()), and the tab-sync text
// (setDisplayText). History matches arrive through a provider so
// the guarded store read stays in the window, like the panels.
#pragma once

#include <QPixmap>
#include <QString>
#include <QWidget>
#include <functional>
#include <utility>
#include <vector>

class QAction;
class QLineEdit;
class QListWidget;
class QListWidgetItem;

class AddressBar : public QWidget {
    Q_OBJECT
public:
    explicit AddressBar(QWidget* parent = nullptr);

    // (title, url) matches for a query, best first.
    using HistoryProvider =
        std::function<std::vector<std::pair<QString, QString>>(const QString& query)>;
    void setHistoryProvider(HistoryProvider provider);

    // Real site logos for suggestion rows (the user's design):
    // host -> stored favicon (null pixmap when none is stored; the
    // row then keeps its generic icon).
    using IconProvider = std::function<QPixmap(const QString& host)>;
    void setIconProvider(IconProvider provider) { iconProvider_ = std::move(provider); }
    // Host the default search engine lives on (e.g. search.brave.com),
    // so "Search for ..." rows can wear that engine's logo.
    void setSearchEngineHost(const QString& host) { searchHost_ = host; }

    void focusBar();                          // focus + select all (Ctrl+L)
    bool hasFocus() const;
    QString text() const;
    void setText(const QString& text);        // programmatic (demo, tests)
    void clear();
    // Tab sync: show the current tab's URL unless the user is typing.
    void setDisplayText(const QString& urlText);
    void setShieldState(bool on, int blockedTotal);
    // The placeholder names the engine searches go to.
    void setSearchEngineName(const QString& name);
    void setBookmarked(bool marked, bool enabled);
    void hideSuggestions();

    // Demo hooks: the demo build runs without a focused window, so
    // it bypasses the focus guard and asks for a rebuild explicitly.
    void setDemoSuggestions(bool on) { demoSuggestions_ = on; }
    void refreshSuggestions() { onTextChanged(text()); }

signals:
    void submitted();          // Enter with no suggestion chosen
    void shieldClicked();      // the Shield badge at the front of the bar
    void bookmarkClicked();

protected:
    bool eventFilter(QObject* watched, QEvent* event) override;

private:
    void onTextChanged(const QString& text);
    void showSuggestions();
    void activateSuggestion(QListWidgetItem* item);

    QLineEdit* edit_ = nullptr;
    QAction* shieldAction_ = nullptr;
    QAction* bookmarkAction_ = nullptr;
    QWidget* popup_ = nullptr;
    QListWidget* list_ = nullptr;
    HistoryProvider historyProvider_;
    IconProvider iconProvider_;
    QString searchHost_;
    QIcon shieldOnIcon_;   // cached badge icons (built once, not per
    QIcon shieldOffIcon_;  // blocked request)
    // Set while a suggestion is being applied, so the text change it
    // causes does not rebuild the popup it just closed.
    bool suppress_ = false;
    bool demoSuggestions_ = false;
};
