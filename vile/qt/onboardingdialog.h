#pragma once
// First-run setup wizard (INTEGRATION.md §4).
// Asks the six privacy questions, plus the local-AI questions only when a
// local AI server was detected. The search-engine options are shown in RANDOM
// order; the default is the backend's default engine (Brave). Unanswered questions get the private
// default. The "AI model" page is only shown if the user said yes to local AI.
#include <QDialog>
#include <map>
#include <string>
#include <vector>

#include "vile/local_ai.hpp"
#include "vile/onboarding.hpp"
#include "vile/storage.hpp"

class QLabel;
class QGraphicsOpacityEffect;
class QProgressBar;
class QPropertyAnimation;
class QPushButton;
class QRadioButton;
class QStackedWidget;

class OnboardingDialog : public QDialog {
    Q_OBJECT
public:
    OnboardingDialog(vile::Database& db, const std::vector<vile::LocalAiProvider>& detected,
                     QWidget* parent = nullptr);

    // Valid only after the dialog is accepted.
    vile::PrivacySettings appliedSettings() const { return applied_; }
    // Apply the private defaults and accept (used by the scripted demo).
    void acceptWithDefaults();

protected:
    bool eventFilter(QObject* watched, QEvent* event) override;

private:
    void showPage(int index);
    void goNext();
    void goBack();
    void finish();
    std::map<std::string, std::string> currentAnswers() const;
    void animateProgress();

    vile::Database& db_;
    std::vector<vile::LocalAiProvider> detected_;
    std::vector<vile::Question> questions_;
    vile::PrivacySettings applied_;

    QStackedWidget* stack_ = nullptr;
    QGraphicsOpacityEffect* stackEffect_ = nullptr;
    QPropertyAnimation* pageAnimation_ = nullptr;
    QProgressBar* progressBar_ = nullptr;
    QPropertyAnimation* progressAnimation_ = nullptr;
    QPushButton* backBtn_ = nullptr;
    QPushButton* nextBtn_ = nullptr;
    // per page: prompt label, option radios, details label
    struct PageWidgets {
        QLabel* details = nullptr;
        std::vector<QRadioButton*> radios;
        std::vector<std::string> optionIds;
        std::vector<vile::AnswerOption> options;
    };
    std::vector<PageWidgets> pages_;
    int page_ = 0;
    int pendingPage_ = -1;
    bool pageShown_ = false;
};
