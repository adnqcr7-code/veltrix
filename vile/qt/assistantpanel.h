#pragma once
// AssistantPanel: the Assistant dock page — the read-only, on-device
// page assistant — extracted from MainWindow, where its widgets, the
// future watcher and the run/finish plumbing sat inside the window's
// constructor and method list. The panel owns:
//   - the status line (with its busy pulse), Explain/Ask controls,
//     the answer box and the "what was sent" activity list;
//   - the assistant run itself: page-text fetch, the QtConcurrent
//     worker (copies only — no window state crosses threads), and
//     applying the outcome.
// The window owns what the panel must not: the page itself (reached
// through the PageAccess functions — tab data and text via the
// core), the privacy settings and the detected provider list
// (pushed in whenever they change).
#include <QFutureWatcher>
#include <QWidget>
#include <functional>
#include <vector>

#include "vile/local_ai.hpp"
#include "vile/privacy.hpp"

class QLabel;
class QLineEdit;
class QListWidget;
class QGraphicsOpacityEffect;
class QPropertyAnimation;
class QPushButton;
class QTextEdit;


struct AssistantOutcome {
    vile::AiResult result;
    std::vector<vile::AiActivity> activity;
};

class AssistantPanel : public QWidget {
    Q_OBJECT
public:
    explicit AssistantPanel(QWidget* parent = nullptr);

    // Inputs the window owns.
    void setSettings(const vile::PrivacySettings& settings);
    void setProviders(std::vector<vile::LocalAiProvider> detected);
    // How the panel reaches the current page — deliberately NOT a
    // widget: the window wires this to the core (tab data from
    // Browser, page text through the Engine port). fetchText is
    // async and may never call back (the tab died first); the run
    // watchdog exists for exactly that.
    struct PageAccess {
        // Fills url/title for the current tab; false when there is none.
        std::function<bool(QString& url, QString& title)> currentPage;
        std::function<void(std::function<void(const QString& text)>)> fetchText;
    };
    void setPageAccess(PageAccess access);
    // The fetch watchdog's interval. Production keeps the default;
    // tests shorten it so the run-state traces are deterministic
    // instead of balanced on wall-clock margins.
    void setFetchWatchdogMs(int ms) { fetchWatchdogMs_ = ms; }

    bool ready() const { return ready_; }

signals:
    // So the window can keep its toolbar Explain button in the same
    // state as the panel's own controls (they once disagreed).
    void readyChanged(bool ready);

private:
    void refresh();
    void runAssistant(const QString& task, const QString& question);
    void onFinished();
    void recoverRun(int generation);  // page-text callback never came

    vile::PrivacySettings settings_;
    std::vector<vile::LocalAiProvider> detected_;
    PageAccess pageAccess_;
    bool ready_ = false;
    bool busy_ = false;        // a run is between click and outcome
    int runGeneration_ = 0;    // identifies the live run to its watchdog
    int fetchWatchdogMs_ = 5000;

    QLabel* status_ = nullptr;
    QPushButton* explainBtn_ = nullptr;
    QLineEdit* question_ = nullptr;
    QPushButton* askBtn_ = nullptr;
    QTextEdit* result_ = nullptr;
    QListWidget* activity_ = nullptr;
    QLabel* sentLabel_ = nullptr;
    QGraphicsOpacityEffect* statusEffect_ = nullptr;
    QPropertyAnimation* pulse_ = nullptr;
    QFutureWatcher<AssistantOutcome> watcher_;
};
