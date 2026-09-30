/**
 * The sections of the Settings page, in menu order. A page that has settings
 * of its own opens Settings at its section rather than keeping a panel of
 * its own, so there is one place to look.
 */
export const SETTINGS_SECTIONS = ['duplicates', 'relocation', 'performance', 'navidrome'] as const;

export type SettingsSection = typeof SETTINGS_SECTIONS[number];

export const DEFAULT_SETTINGS_SECTION: SettingsSection = 'duplicates';

/** The section a `?section=` search parameter names, or undefined for anything else. */
export function parseSettingsSection(value: unknown): SettingsSection | undefined {
  return (SETTINGS_SECTIONS as readonly unknown[]).includes(value) ? value as SettingsSection : undefined;
}
