// Find-in-page bar: the bottom strip with the query edit, the
// "N / M" count, and prev/next/close. Owns its keyboard behaviour
// (Esc closes, Shift+Enter goes backward); the window owns the
// search itself, through the Engine port, and hears findRequested.
// Extracted from MainWindow in fix pass 8, like the AddressBar.
#pragma once

#include <QWidget>

class QLabel;
class QLineEdit;

class FindBar : public QWidget {
    Q_OBJECT
public:
    explicit FindBar(QWidget* parent = nullptr);

    // Re-draw the button icons from the CURRENT palette — they are
    // pixmaps baked at construction, so a live theme switch would
    // otherwise leave them in the outgoing theme (round 13, T1).
    void refreshIcons();
    void showBar();   // show, focus, re-run the current query
    void hideBar();   // hide and report closed() (window clears find)
    QString text() const;
    void setText(const QString& text);  // demo/tests: drives a find
    void setResult(int active, int total);
    void clearResult();

signals:
    void findRequested(const QString& text, bool backward);
    void closed();

protected:
    bool eventFilter(QObject* watched, QEvent* event) override;

private:
    QLineEdit* edit_ = nullptr;
    QLabel* count_ = nullptr;
    class QPushButton* prevBtn_ = nullptr;
    class QPushButton* nextBtn_ = nullptr;
    class QPushButton* closeBtn_ = nullptr;
};
