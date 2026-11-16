#include "onboardingdialog.h"

#include <QFrame>
#include <QGraphicsOpacityEffect>
#include <QHBoxLayout>
#include <QKeyEvent>
#include <QLabel>
#include <QMessageBox>
#include <QPixmap>
#include <QProgressBar>
#include <QPropertyAnimation>
#include <QPushButton>
#include <QRadioButton>
#include <QStackedWidget>
#include <QStyle>
#include <QVBoxLayout>
#include <algorithm>
#include <random>

#include "vile/search_engines.hpp"

using namespace vile;

namespace {
// The ai_model page is only reachable when local_ai was answered "yes".
bool pageVisible(const Question& q, const std::map<std::string, std::string>& answers) {
    if (q.id != "ai_model") return true;
    auto it = answers.find("local_ai");
    return it != answers.end() && it->second == "yes";
}

QString optionMark(const AnswerOption& option) {
    const QString id = QString::fromStdString(option.id).toLower();
    if (id == QStringLiteral("duckduckgo")) return QStringLiteral("D");
    if (id == QStringLiteral("google")) return QStringLiteral("G");
    if (id == QStringLiteral("bing")) return QStringLiteral("b");
    if (id == QStringLiteral("ecosia")) return QStringLiteral("E");
    if (id == QStringLiteral("kagi")) return QStringLiteral("K");
    if (id == QStringLiteral("qwant")) return QStringLiteral("Q");
    const QString label = QString::fromStdString(option.label).trimmed();
    return label.isEmpty() ? QStringLiteral("•") : label.left(1).toUpper();
}
}  // namespace

OnboardingDialog::OnboardingDialog(Database& db, const std::vector<LocalAiProvider>& detected,
                                   QWidget* parent)
    : QDialog(parent), db_(db), detected_(detected) {
    setWindowTitle(tr("Welcome to VILE — first-run setup"));
    setObjectName(QStringLiteral("onboardingDialog"));
    setMinimumSize(620, 520);
    questions_ = Onboarding::questions_for(detected_);

    auto* root = new QVBoxLayout(this);
    root->setContentsMargins(28, 24, 28, 20);
    root->setSpacing(14);
    // Brand header: the transparent mark + wordmark. (The earlier build
    // stretched the aurora artwork into a banner strip — at 64px tall it
    // read as a smudge, and the mark below it made it redundant anyway.)
    auto* headerRow = new QHBoxLayout;
    auto* logo = new QLabel(this);
    logo->setPixmap(QPixmap(QStringLiteral(":/assets/logo-alpha.png"))
                        .scaled(36, 36, Qt::KeepAspectRatio, Qt::SmoothTransformation));
    headerRow->addWidget(logo);
    auto* heading = new QLabel(tr("VILE SETUP"));
    heading->setObjectName(QStringLiteral("onboardingEyebrow"));
    heading->setWordWrap(true);
    headerRow->addWidget(heading);
    headerRow->addStretch(1);
    root->addLayout(headerRow);
    progressBar_ = new QProgressBar(this);
    progressBar_->setObjectName(QStringLiteral("onboardingProgressBar"));
    progressBar_->setRange(0, 100);
    progressBar_->setValue(0);
    progressBar_->setTextVisible(false);
    progressBar_->setFixedHeight(5);
    root->addWidget(progressBar_);
    progressAnimation_ = new QPropertyAnimation(progressBar_, "value", this);
    progressAnimation_->setDuration(360);
    progressAnimation_->setEasingCurve(QEasingCurve::OutCubic);
    stack_ = new QStackedWidget(this);
    stackEffect_ = new QGraphicsOpacityEffect(stack_);
    stackEffect_->setOpacity(1.0);
    stack_->setGraphicsEffect(stackEffect_);
    pageAnimation_ = new QPropertyAnimation(stackEffect_, "opacity", this);
    pageAnimation_->setDuration(220);
    pageAnimation_->setEasingCurve(QEasingCurve::InOutCubic);
    connect(pageAnimation_, &QPropertyAnimation::finished, this, [this] {
        if (pendingPage_ < 0) return;
        const int next = pendingPage_;
        pendingPage_ = -1;
        stack_->setCurrentIndex(next);
        pageAnimation_->setStartValue(0.0);
        pageAnimation_->setEndValue(1.0);
        pageAnimation_->setDuration(240);
        pageAnimation_->setEasingCurve(QEasingCurve::OutCubic);
        pageAnimation_->start();
    });
    root->addWidget(stack_, 1);

    for (const auto& q : questions_) {
        auto* page = new QWidget;
        auto* lay = new QVBoxLayout(page);
        lay->setContentsMargins(4, 2, 4, 2);
        lay->setSpacing(9);
        auto* progress = new QLabel(tr("Step %1 of %2").arg((int)pages_.size() + 1).arg((int)questions_.size()));
        progress->setObjectName(QStringLiteral("onboardingProgress"));
        lay->addWidget(progress);
        auto* prompt = new QLabel(QString::fromStdString(q.prompt));
        prompt->setObjectName(QStringLiteral("onboardingTitle"));
        prompt->setWordWrap(true);
        lay->addWidget(prompt);
        auto* intro = new QLabel;
        intro->setObjectName(QStringLiteral("onboardingDescription"));
        intro->setWordWrap(true);
        intro->setText(q.id == "search_engine"
                           ? tr("Search engines are shown in random order. You can change this later in Settings.")
                           : tr("Choose what feels right. You can change these settings later."));
        lay->addWidget(intro);
        PageWidgets pw;
        // Options in random order for the search-engine question; the default
        // (Brave) is unchanged, only the display order is shuffled.
        std::vector<AnswerOption> options = q.options;
        if (q.id == "search_engine")
            std::shuffle(options.begin(), options.end(),
                         std::mt19937{std::random_device{}()});
        for (const auto& opt : options) {
            auto* card = new QFrame(page);
            card->setObjectName(QStringLiteral("onboardingOption"));
            card->setProperty("selected", opt.id == q.default_id);
            auto* cardLay = new QHBoxLayout(card);
            cardLay->setContentsMargins(12, 9, 12, 9);
            cardLay->setSpacing(10);
            auto* mark = new QLabel(optionMark(opt), card);
            mark->setObjectName(QStringLiteral("onboardingMark"));
            mark->setAlignment(Qt::AlignCenter);
            mark->setFixedSize(28, 28);
            cardLay->addWidget(mark);
            auto* copy = new QVBoxLayout;
            copy->setSpacing(2);
            auto* r = new QRadioButton(QString::fromStdString(opt.label), card);
            r->setObjectName(QStringLiteral("onboardingOptionTitle"));
            r->setChecked(opt.id == q.default_id);
            copy->addWidget(r);
            auto* summary = new QLabel(QString::fromStdString(opt.summary));
            summary->setObjectName(QStringLiteral("onboardingOptionSummary"));
            summary->setWordWrap(true);
            copy->addWidget(summary);
            cardLay->addLayout(copy, 1);
            lay->addWidget(card);
            pw.radios.push_back(r);
            pw.optionIds.push_back(opt.id);
            connect(r, &QRadioButton::toggled, this, [card](bool checked) {
                card->setProperty("selected", checked);
                card->style()->unpolish(card);
                card->style()->polish(card);
                card->update();
            });
        }
        auto* details = new QLabel;
        details->setWordWrap(true);
        details->setStyleSheet(QStringLiteral("color: #555;"));
        lay->addWidget(details);
        pw.details = details;
        details->setVisible(false);
        pw.options = options;
        auto updateDetails = [pw]() {
            for (size_t i = 0; i < pw.radios.size(); ++i) {
                if (!pw.radios[i]->isChecked()) continue;
                const auto& o = pw.options[i];
                QString text = QString::fromStdString(o.promise);
                if (!o.downside.empty())
                    text += QStringLiteral("\nDownside: ") + QString::fromStdString(o.downside);
                if (!o.source_url.empty())
                    text += QStringLiteral("\nSource: ") + QString::fromStdString(o.source_url);
                pw.details->setText(text);
                break;
            }
        };
        for (auto* r : pw.radios)
            connect(r, &QRadioButton::toggled, this, updateDetails);
        updateDetails();
        lay->addStretch(1);
        stack_->addWidget(page);
        pages_.push_back(std::move(pw));
    }

    auto* nav = new QHBoxLayout;
    backBtn_ = new QPushButton(tr("Back"));
    nextBtn_ = new QPushButton(tr("Next"));
    auto* cancelBtn = new QPushButton(tr("Skip setup (use private defaults)"));
    backBtn_->setObjectName(QStringLiteral("secondaryAction"));
    nextBtn_->setObjectName(QStringLiteral("primaryAction"));
    cancelBtn->setObjectName(QStringLiteral("secondaryAction"));
    connect(backBtn_, &QPushButton::clicked, this, &OnboardingDialog::goBack);
    connect(nextBtn_, &QPushButton::clicked, this, &OnboardingDialog::goNext);
    connect(cancelBtn, &QPushButton::clicked, this, [this] {
        // Empty answers -> Onboarding::apply fills in the private defaults.
        applied_ = Onboarding::apply(db_, {}, detected_);
        accept();
    });
    nav->addWidget(backBtn_);
    nav->addWidget(nextBtn_);
    auto* shortcutHint = new QLabel(tr("← / ↑ Back   ·   → / ↓ Next   ·   Enter Continue"));
    shortcutHint->setObjectName(QStringLiteral("onboardingShortcutHint"));
    nav->addWidget(shortcutHint);
    nav->addStretch(1);
    nav->addWidget(cancelBtn);
    root->addLayout(nav);
    installEventFilter(this);
    for (auto* widget : findChildren<QWidget*>()) widget->installEventFilter(this);
    showPage(0);
}

bool OnboardingDialog::eventFilter(QObject* watched, QEvent* event) {
    Q_UNUSED(watched);
    if (event->type() == QEvent::KeyPress) {
        auto* key = static_cast<QKeyEvent*>(event);
        if (key->isAutoRepeat()) return true;
        switch (key->key()) {
        case Qt::Key_Left:
        case Qt::Key_Up:
            goBack();
            return true;
        case Qt::Key_Right:
        case Qt::Key_Down:
        case Qt::Key_Return:
        case Qt::Key_Enter:
            goNext();
            return true;
        default:
            break;
        }
    }
    return QDialog::eventFilter(watched, event);
}

std::map<std::string, std::string> OnboardingDialog::currentAnswers() const {
    std::map<std::string, std::string> answers;
    for (size_t i = 0; i < questions_.size(); ++i) {
        for (size_t j = 0; j < pages_[i].radios.size(); ++j)
            if (pages_[i].radios[j]->isChecked())
                answers[questions_[i].id] = pages_[i].optionIds[j];
    }
    return answers;
}

void OnboardingDialog::showPage(int index) {
    page_ = index;
    if (!pageShown_) {
        stack_->setCurrentIndex(index);
        pageShown_ = true;
    } else if (stack_->currentIndex() != index) {
        pendingPage_ = index;
        pageAnimation_->stop();
        pageAnimation_->setStartValue(stackEffect_->opacity());
        pageAnimation_->setEndValue(0.0);
        pageAnimation_->setDuration(170);
        pageAnimation_->setEasingCurve(QEasingCurve::InCubic);
        pageAnimation_->start();
    }
    backBtn_->setEnabled(index > 0);
    // Next becomes Finish on the last visible page.
    auto answers = currentAnswers();
    int last = (int)questions_.size() - 1;
    while (last > index && !pageVisible(questions_[last], answers)) --last;
    nextBtn_->setText(index >= last ? tr("Finish") : tr("Next"));
    animateProgress();
}

void OnboardingDialog::animateProgress() {
    if (!progressBar_ || questions_.empty()) return;
    const auto answers = currentAnswers();
    int visibleTotal = 0;
    int visiblePosition = 0;
    for (int i = 0; i < static_cast<int>(questions_.size()); ++i) {
        if (!pageVisible(questions_[i], answers)) continue;
        ++visibleTotal;
        if (i <= page_) ++visiblePosition;
    }
    if (visibleTotal <= 0) return;
    const int target = qBound(1, (visiblePosition * 100) / visibleTotal, 100);
    progressAnimation_->stop();
    progressAnimation_->setStartValue(progressBar_->value());
    progressAnimation_->setEndValue(target);
    progressAnimation_->start();
}

void OnboardingDialog::goBack() {
    auto answers = currentAnswers();
    int i = page_ - 1;
    while (i > 0 && !pageVisible(questions_[i], answers)) --i;
    showPage(std::max(0, i));
}

void OnboardingDialog::goNext() {
    auto answers = currentAnswers();
    int last = (int)questions_.size() - 1;
    while (last > page_ && !pageVisible(questions_[last], answers)) --last;
    if (page_ >= last) {
        finish();
        return;
    }
    int i = page_ + 1;
    while (i < last && !pageVisible(questions_[i], answers)) ++i;
    showPage(i);
}

void OnboardingDialog::finish() {
    auto answers = currentAnswers();
    std::string problem = Onboarding::validate(answers, detected_);
    if (!problem.empty()) {
        QMessageBox::warning(this, tr("Check your answers"), QString::fromStdString(problem));
        return;
    }
    try {
        applied_ = Onboarding::apply(db_, answers, detected_);
    } catch (const std::invalid_argument& e) {
        QMessageBox::warning(this, tr("Check your answers"), QString::fromStdString(e.what()));
        return;
    }
    accept();
}

void OnboardingDialog::acceptWithDefaults() {
    applied_ = Onboarding::apply(db_, {}, detected_);
    accept();
}
