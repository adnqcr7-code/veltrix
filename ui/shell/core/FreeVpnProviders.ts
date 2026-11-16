// FreeVpnProviders — the built-in free VPN options Settings → Network may
// offer. DATA ONLY: no network calls, no credentials, no downloads. The UI
// renders these; the user still adds a provider themselves (a free account,
// or the provider's own app) — nothing here connects on its own.
//
// VETTING (2026-11-13, strict bar — Adnan: safe and most halal above all;
// only trustworthy providers with a clear no-logging policy; if a provider
// cannot be verified trustworthy and no-logging, it is NOT listed):
//
//   INCLUDED — Proton VPN Free. Swiss company (Proton AG), open-source apps,
//   no-logs policy independently audited every year since 2022 by Securitum
//   (5th annual audit announced June 2026) plus a SOC 2 Type II attestation.
//   Free forever, unlimited data, no payment card. CATCH: needs a free
//   Proton account (email). Free servers are auto-selected (~10 countries),
//   1 device, no P2P. A free account can download a WireGuard .conf from
//   Proton, which the existing Add VPN import already accepts — that is the
//   path the UI offers.
//   INCLUDED — RiseupVPN. Free, donation-funded, no account, no email, no
//   payment, run by the Riseup collective (since 1999). The operator states
//   it logs no IP addresses and no DNS queries, and publishes a quarterly
//   PGP-signed warrant canary. CAVEATS, stated in the UI: no independent
//   no-logs audit exists (the claim is the operator's word), US jurisdiction,
//   small network, slower speeds, and it connects through its own Bitmask
//   app (AUR: riseup-vpn), NOT through NetworkManager — so Veltrix cannot
//   show its status or disconnect it.
//   EXCLUDED — CalyxVPN. Also a nonprofit, also free with no account, but
//   no independent no-logs audit either, no kill switch, and sources
//   disagree on whether access needs a donation token — not verified well
//   enough to recommend. Left out on purpose.
//   EXCLUDED — everything else that calls itself "free": VPN Gate
//   (volunteer nodes, unknown logging), and the ad/data-funded free VPNs
//   (TurboVPN, Hola, SuperVPN and the like — logging and data-selling are
//   their business model). A VPN provider sees ALL of your traffic; a shady
//   free VPN is worse than no VPN. The list is short on purpose.
//
// The user adds their OWN servers too (import .conf/.ovpn, or the manual
// WireGuard form) — that is their choice, and this list never implies a
// provider is safe just because it is free. See NetworkService.ts
// (importVpnProfile / addManualWireGuard) for the secret handling: keys are
// never read, logged or stored in plaintext by our code.

import type { t } from "./i18n"

/** An i18n key — so a typo'd key fails the typecheck instead of rendering English. */
export type I18nKey = Parameters<typeof t>[0]

export type FreeVpnProviderId = "proton" | "riseup"

export interface FreeVpnProvider {
    id: FreeVpnProviderId
    /** i18n keys — the UI resolves them, this module holds no user text. */
    nameKey: I18nKey
    descKey: I18nKey
    /** "Needs a free account" vs "No account needed" — always shown. */
    accountKey: I18nKey
    /** Numbered setup steps, shown in the "How to set up" dialog. */
    setupKey: I18nKey
}

export const FREE_VPN_PROVIDERS: readonly FreeVpnProvider[] = [
    {
        id: "proton",
        nameKey: "settings.network.free-vpn.proton.name",
        descKey: "settings.network.free-vpn.proton.desc",
        accountKey: "settings.network.free-vpn.account.needed",
        setupKey: "settings.network.free-vpn.proton.setup",
    },
    {
        id: "riseup",
        nameKey: "settings.network.free-vpn.riseup.name",
        descKey: "settings.network.free-vpn.riseup.desc",
        accountKey: "settings.network.free-vpn.account.none",
        setupKey: "settings.network.free-vpn.riseup.setup",
    },
]
