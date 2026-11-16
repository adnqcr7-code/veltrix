#pragma once
// Settings: a two-pane window (sections on the left, one page per section),
// not a tabbed modal. Every control explains itself in one line. The
// appearance / new-tab / downloads controls PREVIEW live (the window
// behind reacts at once), but Cancel is honest: the dialog snapshots
// every live channel on open and restores it on reject, so Cancel
// still means cancel. One Appearance control is the exception that
// proves the wording matters: "Ask sites for their dark theme" is a stored
// preference, not a preview — it takes effect on the next launch,
// and its row says so. Only the privacy settings are staged outright
// (they wait for OK because they reconfigure the Shield). Actions —
// updating the blocklist, clearing data — are not settings and are
// not undone by Cancel.
//
// Search engines are shown in RANDOM order every time the dialog opens (the
// Helium-style setup behaviour from INTEGRATION.md §4). The default stays
// Brave: shuffling changes the display order only, never the default.
#include <QDialog>
#include <QPointer>
#include <QVector>
#include <vector>

#include "vile/local_ai.hpp"
#include "vile/privacy.hpp"

class QCheckBox;
class QComboBox;
class QLabel;
class QListWidget;
class QLineEdit;
class QPushButton;
class QRadioButton;
class QShowEvent;
class QStackedWidget;
class QVBoxLayout;

class SettingsDialog : public QDialog {
    Q_OBJECT
public:
    SettingsDialog(vile::PrivacySettings settings,
                   const std::vector<vile::LocalAiProvider>& detected,
                   const QString& blocklistInfo, QWidget* parent = nullptr);

    vile::PrivacySettings settings() const;
    // Cancel restores the live-preview snapshot taken on open.
    void reject() override;
    void refreshBlocklistInfo(const QString& info);
    // Settings search (the settings tab's search bar): finds the
    // settings whose text matches the query — an exact substring if
    // there is one, otherwise the closest letter-by-letter match —
    // paints the matched LETTERS (not the whole row), jumps to the
    // best match's page, and returns the match count. An empty
    // query clears the highlights.
    int highlightSearch(const QString& query);
    // Embedded mode (the settings TAB): no OK/Cancel and no
    // self-resizing — privacy settings apply LIVE through
    // privacySettingsChanged, the way browser settings pages work.
    void setEmbedded(bool on);
    void setCurrentPage(int index);

signals:
    void privacySettingsChanged(const vile::PrivacySettings& settings);
    void requestBlocklistUpdate();
    void requestClearData();
    void themeChanged(const QString& themeId);

private:
    void rebuildModelCombo();
    // Fit the dialog height to a short page (see the ctor): scrolling
    // pages keep the full height, plain pages shrink the dialog to
    // their content instead of ending halfway over dead space.
    void fitToCurrentPage();
    void showEvent(QShowEvent* event) override;
    // A checkbox with a one-line explanation under it; returns the
    // checkbox. The title is a separate label (see settingRow's
    // comment in the .cpp) that toggles the box when clicked.
    QCheckBox* settingRow(QVBoxLayout* lay, const QString& title,
                          const QString& desc, bool checked);
    bool eventFilter(QObject* obj, QEvent* event) override;
    void wireLiveApply();
    static void pageHeader(QVBoxLayout* lay, const QString& title, const QString& desc);

    // Live-preview snapshot (see the class comment): the values the
    // live channels held when the dialog opened.
    struct LiveSnapshot {
        QString theme;
        bool restoreSession = true;
        bool suggestions = true;
        bool ntpClock = true, ntpTiles = true, ntpStats = true, ntpVisited = true;
        QString downloadsFolder;
        bool askWhereSave = false;
        QStringList userDomains;
        bool forceDarkPages = true;
        bool railHover = true;
        int railDelayMs = 1000;
        bool verticalTabs = true;
    };
    LiveSnapshot snapshot_;
    QString themeNow_;

    QStackedWidget* pages_ = nullptr;
    vile::PrivacySettings settings_;
    std::vector<vile::LocalAiProvider> detected_;

    QCheckBox* httpsOnly_ = nullptr;
    QCheckBox* blockTrackers_ = nullptr;
    QCheckBox* blockCookies_ = nullptr;
    QCheckBox* saveHistory_ = nullptr;
    QCheckBox* clearOnExit_ = nullptr;
    QCheckBox* sendGpc_ = nullptr;
    QVector<QRadioButton*> engineRadios_;
    QVector<QString> engineIds_;
    QCheckBox* aiEnabled_ = nullptr;
    QComboBox* aiProvider_ = nullptr;
    QComboBox* aiModel_ = nullptr;
    QLabel* downloadFolderLabel_ = nullptr;
    QLabel* blocklistInfo_ = nullptr;
    QListWidget* userDomainsList_ = nullptr;
    struct RichRestore {
        QPointer<QLabel> label;
        QString text;
    };
    QList<RichRestore> searchRich_;
    bool embedded_ = false;
    bool liveWired_ = false;
    class QDialogButtonBox* buttons_ = nullptr;
    QLabel* updateStatus_ = nullptr;
    QPushButton* updateOpenBtn_ = nullptr;
    QString updateUrl_;
};
