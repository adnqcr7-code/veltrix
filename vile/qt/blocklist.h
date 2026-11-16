#pragma once
// Blocklist loading for the VILE Qt UI.
//
// Sources, in order:
//   1. The downloaded maintained list (StevenBlack unified hosts, hosts format)
//      at <dataDir>/blocklists/hosts.txt, written by "Update blocklist".
//   2. The bundled curated list (:/blocklists/trackers.txt), the offline fallback.
//   3. The 14-domain seed set compiled into Shield (already loaded by its ctor).
//
// Both hosts-format lines ("0.0.0.0 domain") and EasyPrivacy-style rules
// ("||domain^") are accepted; the latter are converted to plain domains first.
#include <QString>
#include <QStringList>
#include <functional>

namespace vile {
class Shield;
}

namespace blocklist {

// Loads the best available list into the shield. Returns the number of rules
// added by this call and a human-readable description of which source was used.
size_t load(vile::Shield& shield, const QString& dataDir, QString* sourceDescription);

// How many rules the bundled list parses to — the protection floor a
// downloaded list must reach before it may displace anything.
size_t bundledRuleCount();

// Downloads the maintained StevenBlack unified hosts file into
// <dataDir>/blocklists/hosts.txt. The callback runs on the UI thread with
// (ok, message); the caller recreates the Shield and calls load() again,
// because Shield has no "clear rules" operation.
void updateFromNetwork(const QString& dataDir, const std::function<void(bool, const QString&)>& done);

// URL of the maintained list.
QString maintainedListUrl();

// Converts one blocklist text (hosts and/or EasyPrivacy style) into plain
// hosts-format text that Shield::add_rules_from_text understands.
QString normalizeText(const QString& text);

}  // namespace blocklist
