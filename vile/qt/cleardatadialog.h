#pragma once

#include <QDialog>

class QCheckBox;
class QComboBox;

// "Clear browsing data": choose what to wipe and, for history, how far
// back. Site data is always cleared in full (the engine has no ranged
// wipe) and the dialog says so next to its checkbox.
class ClearDataDialog : public QDialog {
    Q_OBJECT
public:
    explicit ClearDataDialog(QWidget* parent = nullptr);

    bool clearHistory() const;
    bool clearSiteData() const;
    // 0 = all time; otherwise entries last visited within N hours go.
    int historyRangeHours() const;

private:
    QCheckBox* history_ = nullptr;
    QCheckBox* siteData_ = nullptr;
    QComboBox* range_ = nullptr;
};
