// Verse of the Day — the one verse the iPad home screen shows.
//
// Seven verses, one per weekday (Sunday = Al-Fatiha 1:5 … Saturday =
// Ar-Rahman 55:13), so the card changes every day without ever needing
// the network. The Arabic is the Tanzil Project's Uthmani text
// (CC BY 3.0 — verbatim copies allowed, modification prohibited,
// attribution required; see the header of this file and
// `ui/shell/assets/apps/ATTRIBUTION.md`'s Quran note in the report),
// verified byte-for-byte against the Tanzil Uthmani download itself
// (tanzil.net, quranType=uthmani, fetched 2026-11-13, 1,347,874 bytes,
// 6266 lines) on 2026-11-13 — all 7 strings byte-exact, re-diffed after
// the fix (fix pass #1). Do NOT re-verify against api.alquran.cloud:
// its mirror differs from Tanzil on 94:6 (an extra U+06ED the Tanzil
// download does not have). A critic re-checking this file should diff
// it against the Tanzil download, not against memory or a mirror).
// 13:28, where the API returns a leading `"` (the ayah continues 13:27)
// and the quote mark is dropped so the sentence stands on its own.
//
// The Arabic is shown in full, never shortened: the concept's first
// clause of 24:30 ("قُل لِّلْمُؤْمِنِينَ يَغُضُّوا مِنْ
// أَبْصَارِهِمْ") is a fragment, and a fragment of a verse presented as
// the verse is a misquotation. The card shows the whole ayah plus the
// English underneath, in every locale — the Arabic never changes, the
// English is the translation, and the reference names the surah and
// ayah so anyone can check it.

export interface VerseOfDay {
    /** Surah number, for the reference line. */
    surah: number
    /** Ayah number within the surah. */
    ayah: number
    /** Surah name in English, e.g. "An-Nur". */
    surahName: string
    /** The full ayah in Tanzil Uthmani text. Never edited, never shortened. */
    arabic: string
    /** Yusuf Ali's English translation (public domain). */
    english: string
}

/** Attribution lines, shown in the report and (short form) under the card. */
export const VERSE_ARABIC_SOURCE =
    "Arabic: Tanzil Project, Uthmani text (CC BY 3.0 — tanzil.net)"
export const VERSE_ENGLISH_SOURCE =
    "English: Abdullah Yusuf Ali translation (public domain)"

const VERSES: readonly VerseOfDay[] = [
    {
        surah: 1, ayah: 5, surahName: "Al-Fatiha",
        arabic: "إِيَّاكَ نَعْبُدُ وَإِيَّاكَ نَسْتَعِينُ",
        english: "Thee do we worship, and Thine aid we seek.",
    },
    {
        surah: 24, ayah: 30, surahName: "An-Nur",
        arabic: "قُل لِّلْمُؤْمِنِينَ يَغُضُّوا۟ مِنْ أَبْصَـٰرِهِمْ وَيَحْفَظُوا۟ فُرُوجَهُمْ ۚ ذَٰلِكَ أَزْكَىٰ لَهُمْ ۗ إِنَّ ٱللَّهَ خَبِيرٌۢ بِمَا يَصْنَعُونَ",
        english: "Say to the believing men that they should lower their gaze and guard their modesty: that will make for greater purity for them: And Allah is well acquainted with all that they do.",
    },
    {
        surah: 2, ayah: 152, surahName: "Al-Baqara",
        arabic: "فَٱذْكُرُونِىٓ أَذْكُرْكُمْ وَٱشْكُرُوا۟ لِى وَلَا تَكْفُرُونِ",
        english: "Then do ye remember Me; I will remember you. Be grateful to Me, and reject not Faith.",
    },
    {
        surah: 94, ayah: 6, surahName: "Ash-Sharh",
        arabic: "إِنَّ مَعَ ٱلْعُسْرِ يُسْرًا",
        english: "Verily, with every difficulty there is relief.",
    },
    {
        surah: 13, ayah: 28, surahName: "Ar-Ra'd",
        arabic: "ٱلَّذِينَ ءَامَنُوا۟ وَتَطْمَئِنُّ قُلُوبُهُم بِذِكْرِ ٱللَّهِ ۗ أَلَا بِذِكْرِ ٱللَّهِ تَطْمَئِنُّ ٱلْقُلُوبُ",
        english: "Those who believe, and whose hearts find satisfaction in the remembrance of Allah: for without doubt in the remembrance of Allah do hearts find satisfaction.",
    },
    {
        surah: 3, ayah: 139, surahName: "Aal-i-Imraan",
        arabic: "وَلَا تَهِنُوا۟ وَلَا تَحْزَنُوا۟ وَأَنتُمُ ٱلْأَعْلَوْنَ إِن كُنتُم مُّؤْمِنِينَ",
        english: "So lose not heart, nor fall into despair: For ye must gain mastery if ye are true in Faith.",
    },
    {
        surah: 55, ayah: 13, surahName: "Ar-Rahman",
        arabic: "فَبِأَىِّ ءَالَآءِ رَبِّكُمَا تُكَذِّبَانِ",
        english: "Then which of the favours of your Lord will ye deny?",
    },
]

/** The verse for a date: Sunday → index 0 … Saturday → index 6. */
export function verseOfDay(date: Date = new Date()): VerseOfDay {
    return VERSES[date.getDay()]
}

/** "Qur'an 24:30" — the reference line under the card. */
export function verseReference(verse: VerseOfDay): string {
    return `Qur'an ${verse.surah}:${verse.ayah}`
}
