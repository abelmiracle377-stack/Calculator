const LANGUAGE_CATALOG = [
  { code: "ar", label: "Arabic" },
  { code: "bn", label: "Bengali" },
  { code: "bg", label: "Bulgarian" },
  { code: "ca", label: "Catalan" },
  { code: "zh", label: "Chinese" },
  { code: "hr", label: "Croatian" },
  { code: "cs", label: "Czech" },
  { code: "da", label: "Danish" },
  { code: "nl", label: "Dutch" },
  { code: "en", label: "English" },
  { code: "fi", label: "Finnish" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "el", label: "Greek" },
  { code: "he", label: "Hebrew" },
  { code: "hi", label: "Hindi" },
  { code: "hu", label: "Hungarian" },
  { code: "id", label: "Indonesian" },
  { code: "it", label: "Italian" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
  { code: "ms", label: "Malay" },
  { code: "no", label: "Norwegian" },
  { code: "pl", label: "Polish" },
  { code: "pt", label: "Portuguese" },
  { code: "ro", label: "Romanian" },
  { code: "ru", label: "Russian" },
  { code: "sk", label: "Slovak" },
  { code: "es", label: "Spanish" },
  { code: "sv", label: "Swedish" },
  { code: "ta", label: "Tamil" },
  { code: "te", label: "Telugu" },
  { code: "th", label: "Thai" },
  { code: "tr", label: "Turkish" },
  { code: "uk", label: "Ukrainian" },
  { code: "ur", label: "Urdu" },
  { code: "vi", label: "Vietnamese" },
] as const;

export type TranslationLanguageCode = "auto" | (typeof LANGUAGE_CATALOG)[number]["code"];
export type TranslationTargetLanguage = Exclude<TranslationLanguageCode, "auto">;
export interface TranslationLanguageOption { code: TranslationLanguageCode; label: string; }
export interface TranslationTargetLanguageOption { code: TranslationTargetLanguage; label: string; }
export interface TranslationLanguageSelection {
  source_language: TranslationLanguageCode;
  target_language: TranslationTargetLanguage;
}
export interface TranslationSelectionValidation extends TranslationLanguageSelection {
  valid: boolean;
  error?: string;
}

export const TRANSLATION_LANGUAGES: readonly TranslationTargetLanguageOption[] = LANGUAGE_CATALOG;
export const TRANSLATION_SOURCE_LANGUAGES: readonly TranslationLanguageOption[] = [
  { code: "auto", label: "Auto Detect" },
  ...TRANSLATION_LANGUAGES,
];
export const TRANSLATION_TARGET_LANGUAGES: readonly TranslationTargetLanguageOption[] = TRANSLATION_LANGUAGES;
export const DEFAULT_TRANSLATION_SOURCE_LANGUAGE: TranslationLanguageCode = "auto";
export const DEFAULT_TRANSLATION_TARGET_LANGUAGE: TranslationTargetLanguage = "en";

function normalizedValue(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase().replace(/_/g, "-").replace(/\s+/g, " ") : "";
}

export function normalizeTranslationLanguage(value: unknown): TranslationLanguageCode | "" {
  const raw = normalizedValue(value);
  if (["auto", "automatic", "detect", "auto-detect"].includes(raw)) return "auto";
  const option = TRANSLATION_LANGUAGES.find(({ code, label }) => code === raw || label.toLowerCase() === raw);
  return option?.code || "";
}

export function normalizeTranslationSourceLanguage(value: unknown): TranslationLanguageCode {
  return normalizeTranslationLanguage(value) || DEFAULT_TRANSLATION_SOURCE_LANGUAGE;
}

export function normalizeTranslationTargetLanguage(value: unknown): TranslationTargetLanguage {
  const normalized = normalizeTranslationLanguage(value);
  return normalized && normalized !== "auto" ? normalized : DEFAULT_TRANSLATION_TARGET_LANGUAGE;
}

export function isValidTranslationSourceLanguage(value: unknown): boolean {
  return normalizeTranslationLanguage(value) !== "";
}

export function isValidTranslationTargetLanguage(value: unknown): boolean {
  const normalized = normalizeTranslationLanguage(value);
  return Boolean(normalized && normalized !== "auto");
}

export function isSameExplicitTranslationLanguage(sourceLanguage: unknown, targetLanguage: unknown): boolean {
  const source = normalizeTranslationLanguage(sourceLanguage);
  const target = normalizeTranslationLanguage(targetLanguage);
  return Boolean(source && source !== "auto" && target && target !== "auto" && source === target);
}

export function ensureDistinctTranslationTarget(sourceLanguage: unknown, targetLanguage: unknown): TranslationTargetLanguage {
  const source = normalizeTranslationSourceLanguage(sourceLanguage);
  const target = normalizeTranslationTargetLanguage(targetLanguage);
  if (source === "auto" || source !== target) return target;
  const preferred = TRANSLATION_TARGET_LANGUAGES.find(({ code }) => code === DEFAULT_TRANSLATION_TARGET_LANGUAGE && code !== source);
  return preferred?.code || TRANSLATION_TARGET_LANGUAGES.find(({ code }) => code !== source)?.code || DEFAULT_TRANSLATION_TARGET_LANGUAGE;
}

export function validateTranslationSelection(sourceLanguage: unknown, targetLanguage: unknown): TranslationSelectionValidation {
  const source = normalizeTranslationLanguage(sourceLanguage);
  const target = normalizeTranslationLanguage(targetLanguage);
  const safeSource = source || DEFAULT_TRANSLATION_SOURCE_LANGUAGE;
  const safeTarget = target && target !== "auto" ? target : DEFAULT_TRANSLATION_TARGET_LANGUAGE;
  if (!source) return { valid: false, source_language: safeSource, target_language: safeTarget, error: "Choose a source language or Auto Detect." };
  if (!target || target === "auto") return { valid: false, source_language: safeSource, target_language: safeTarget, error: "Choose a target language." };
  if (isSameExplicitTranslationLanguage(source, target)) return { valid: false, source_language: safeSource, target_language: safeTarget, error: "Source and target languages must be different." };
  return { valid: true, source_language: safeSource, target_language: safeTarget };
}

export function swapTranslationLanguages(sourceLanguage: unknown, targetLanguage: unknown): TranslationLanguageSelection {
  const source = normalizeTranslationSourceLanguage(sourceLanguage);
  const target = normalizeTranslationTargetLanguage(targetLanguage);
  if (source === "auto") return { source_language: source, target_language: target };
  return { source_language: target, target_language: source };
}
