#include "assistantpanel.h"

#include <QHBoxLayout>
#include <QLabel>
#include <QLineEdit>
#include <QListWidget>
#include <QGraphicsOpacityEffect>
#include <QPointer>
#include <QPropertyAnimation>
#include <QPushButton>
#include <QTextEdit>
#include <QTimer>
#include <QVBoxLayout>
#include <QtConcurrent>

#include "vile/http.hpp"

AssistantPanel::AssistantPanel(QWidget* parent) : QWidget(parent) {
    auto* lay = new QVBoxLayout(this);
    lay->setContentsMargins(16, 16, 16, 16);
    lay->setSpacing(12);
    auto* aiTitle = new QLabel(tr("Page assistant"));
    aiTitle->setObjectName(QStringLiteral("panelTitle"));
    lay->addWidget(aiTitle);
    auto* aiMeta = new QLabel(tr("Read-only. It only talks to software on this computer."));
    aiMeta->setObjectName(QStringLiteral("mutedLabel"));
    aiMeta->setWordWrap(true);
    lay->addWidget(aiMeta);
    status_ = new QLabel;
    status_->setObjectName(QStringLiteral("mutedLabel"));
    status_->setWordWrap(true);
    statusEffect_ = new QGraphicsOpacityEffect(status_);
    statusEffect_->setOpacity(1.0);
    status_->setGraphicsEffect(statusEffect_);
    pulse_ = new QPropertyAnimation(statusEffect_, "opacity", status_);
    pulse_->setDuration(1100);
    pulse_->setStartValue(0.52);
    pulse_->setEndValue(1.0);
    pulse_->setEasingCurve(QEasingCurve::InOutSine);
    pulse_->setLoopCount(-1);
    lay->addWidget(status_);
    explainBtn_ = new QPushButton(tr("Explain this page"));
    // The toolbar carries this action; in the panel it's a quiet
    // secondary, not a second slab competing with it.
    explainBtn_->setObjectName(QStringLiteral("secondaryAction"));
    connect(explainBtn_, &QPushButton::clicked, this,
            [this] { runAssistant(QStringLiteral("explain"), QString()); });
    lay->addWidget(explainBtn_);
    auto* askRow = new QHBoxLayout;
    question_ = new QLineEdit;
    question_->setPlaceholderText(tr("Ask about this page…"));
    askBtn_ = new QPushButton(tr("Ask"));
    askRow->addWidget(question_, 1);
    askRow->addWidget(askBtn_);
    lay->addLayout(askRow);
    connect(askBtn_, &QPushButton::clicked, this, [this] {
        runAssistant(QStringLiteral("question"), question_->text());
    });
    connect(question_, &QLineEdit::returnPressed, askBtn_, &QPushButton::click);
    result_ = new QTextEdit;
    result_->setReadOnly(true);
    result_->setPlaceholderText(tr("The assistant's answer appears here."));
    // The answer surface fills the panel's surplus (stretch 1 below):
    // a MINIMUM height, not a fixed one — round 12's code review
    // caught a setFixedHeight(120) here neutralising the stretch,
    // with this comment claiming the opposite of the line above it.
    result_->setMinimumHeight(120);
    lay->addWidget(result_, 1);  // the answer surface fills the panel
    auto* sentLabel = new QLabel(tr("What was sent to the model:"));
    sentLabel->setObjectName(QStringLiteral("sectionLabel"));
    sentLabel_ = sentLabel;
    sentLabel->setVisible(false);  // appears with the first exchange
    lay->addWidget(sentLabel);
    activity_ = new QListWidget;
    // A diagnostic, not a reading surface: cap its height so the
    // answer box keeps the panel.
    activity_->setMaximumHeight(110);
    activity_->setVisible(false);
    lay->addWidget(activity_);
    auto* foot = new QLabel(
        tr("The assistant reads only the page in front of you, talks "
           "only to software on this computer, and cannot click, "
           "type, or buy anything."),
        this);
    foot->setObjectName(QStringLiteral("panelFoot"));
    foot->setWordWrap(true);
    lay->addWidget(foot);

    connect(&watcher_, &QFutureWatcher<AssistantOutcome>::finished, this,
            &AssistantPanel::onFinished);
    refresh();
}

void AssistantPanel::setSettings(const vile::PrivacySettings& settings) {
    settings_ = settings;
    refresh();
}

void AssistantPanel::setProviders(std::vector<vile::LocalAiProvider> detected) {
    detected_ = std::move(detected);
    refresh();
}

void AssistantPanel::setPageAccess(PageAccess access) {
    pageAccess_ = std::move(access);
}

void AssistantPanel::refresh() {
    // Two different things: whether the AI is ready (the toolbar's
    // state, tracked by ready_) and whether the controls are usable
    // right now (not mid-run — a settings push can land during a run
    // and must not re-enable them under it).
    const bool ready = settings_.ai_ready();
    const bool usable = ready && !busy_;
    explainBtn_->setEnabled(usable);
    askBtn_->setEnabled(usable);
    question_->setEnabled(usable);
    if (ready) {
        status_->setText(tr("Local AI ready: %1 / %2 (on-device only).")
                             .arg(QString::fromStdString(settings_.ai_provider),
                                  QString::fromStdString(settings_.ai_model)));
    } else if (detected_.empty()) {
        status_->setText(tr("Local AI is off: no Ollama, LM Studio or llama.cpp server "
                            "was found on this computer. Start one and reopen VILE, "
                            "or enable it in Settings."));
    } else {
        status_->setText(tr("Local AI detected but not enabled. Turn it on in Settings "
                            "to use the page assistant."));
    }
    if (ready != ready_) {
        ready_ = ready;
        emit readyChanged(ready);
    }
}

void AssistantPanel::runAssistant(const QString& task, const QString& question) {
    if (busy_) return;  // one run at a time: a second click must not
                        // setFuture() over an in-flight run
    QString url, title;
    if (!pageAccess_.currentPage || !pageAccess_.fetchText ||
        !pageAccess_.currentPage(url, title) ||
        !settings_.ai_ready())
        return;
    busy_ = true;
    const int generation = ++runGeneration_;  // this run's token
    explainBtn_->setEnabled(false);
    askBtn_->setEnabled(false);
    result_->setPlainText(tr("Asking the on-device model… (this can take up to a couple of minutes)"));
    pulse_->start();
    // Watchdog: if the page-text callback never fires (the tab was
    // closed first and the page took the callback with it), recover
    // instead of leaving the panel wedged mid-run.
    QTimer::singleShot(fetchWatchdogMs_, this,
                       [this, generation] { recoverRun(generation); });
    // The worker thread gets copies only (settings + page), so closing
    // the window mid-answer cannot use a destroyed panel. The
    // page-text callback itself is guarded by a QPointer.
    QPointer<AssistantPanel> self(this);
    vile::PrivacySettings assistantSettings = settings_;
    pageAccess_.fetchText([self, task, question, url, title, assistantSettings,
                           generation](const QString& text) {
        if (!self) return;
        // Token check first: if this callback belongs to a run that
        // was already recovered (or superseded), it drops itself.
        if (self->runGeneration_ != generation) return;
        // The fetch landed: retire THIS run's watchdog by advancing
        // the token. (Pass 8's compare-only version forgot this, and
        // the watchdog fired five seconds into the model phase of
        // every healthy run — the bump that pass 7 was criticised
        // for was, in part, load-bearing. It is safe now because a
        // stale callback can no longer REACH this line: it fails
        // the check above, and the next run takes a fresh token.)
        ++self->runGeneration_;
        vile::PageContext page{url.toStdString(), title.toStdString(), text.toStdString()};
        QFuture<AssistantOutcome> future = QtConcurrent::run([page, task, question, assistantSettings] {
            vile::LoopbackHttp http;
            vile::LocalAssistant assistant(http, assistantSettings);
            AssistantOutcome out;
            out.result = task == QStringLiteral("explain")
                             ? assistant.explain_page(page)
                             : assistant.ask_about_page(page, question.toStdString());
            out.activity = assistant.activity();
            return out;
        });
        self->watcher_.setFuture(future);
    });
}

void AssistantPanel::recoverRun(int generation) {
    if (!busy_ || generation != runGeneration_) return;
    busy_ = false;
    ++runGeneration_;  // invalidate the token: a late callback from
                       // this run now drops itself at its token check
    pulse_->stop();
    statusEffect_->setOpacity(1.0);
    result_->setPlainText(
        tr("Couldn't read the page — it was closed, or took too long to read."));
    refresh();
}

void AssistantPanel::onFinished() {
    busy_ = false;
    AssistantOutcome out = watcher_.result();
    pulse_->stop();
    statusEffect_->setOpacity(1.0);
    result_->setPlainText(out.result.ok ? QString::fromStdString(out.result.text)
                                        : tr("Error: ") + QString::fromStdString(out.result.error));
    for (const auto& a : out.activity) {
        activity_->addItem(
            tr("%1 · %2 / %3 · %4 chars sent")
                .arg(QString::fromStdString(a.url), QString::fromStdString(a.provider),
                     QString::fromStdString(a.model))
                .arg(a.chars_sent));
    }
    // The "what was sent" section exists only once something was sent.
    if (activity_->count() > 0) {
        if (sentLabel_) sentLabel_->setVisible(true);
        activity_->setVisible(true);
    }
    refresh();
}
