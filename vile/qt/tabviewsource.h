// The tab strip's view dependency, narrowed to exactly what it uses:
// resolving a tab to its WebEngine view. QtEngine implements this;
// the controller no longer names the concrete engine class, so its
// sync logic can be driven by anything that can hand out views.
#pragma once

#include "vile/browser.hpp"  // vile::TabId

#include <QPixmap>
#include <QString>

class QWebEngineView;

class TabViewSource {
public:
    virtual ~TabViewSource() = default;
    // NOT named viewFor: vile::TabId is an alias of vile::ViewId, so
    // an overload pair on those types is one function — an adapter
    // written against it recursed into itself (found by segfault).
    virtual QWebEngineView* viewForTab(vile::TabId id) = 0;
    // The stored site logo for a host (the favicon store), empty
    // when none is kept. The strip prefers it over the live view's
    // icon: Chromium hands the view an icon only while its page is
    // alive, but the store keeps the logo across sessions, so a
    // restored tab shows its site's mark immediately. Default: none.
    virtual QPixmap faviconPixmap(const QString&, int) const { return {}; }
};
