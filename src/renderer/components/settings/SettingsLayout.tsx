import React from 'react';
import { Copy, Cpu, MapPin, Settings as SettingsIcon } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { PageHeader } from '../ui';
import { SettingsPanel } from '../SettingsPanel';
import { useSettingsStore } from '../../stores/settingsStore';
import { RelocationSettings } from './RelocationSettings';
import { WorkersPanel } from './WorkersPanel';
import { SETTINGS_SECTIONS, type SettingsSection } from '../../settings/sections';

const SECTION_META: Record<SettingsSection, { label: string; description: string; icon: LucideIcon }> = {
  duplicates: {
    label: 'Duplicate Detection',
    description: 'How duplicates are found, which copy is kept, and the folders it is preferred from.',
    icon: Copy,
  },
  relocation: {
    label: 'Track Relocation',
    description: 'Where the relocator looks for missing tracks, and how close a match has to be.',
    icon: MapPin,
  },
  performance: {
    label: 'Performance',
    description: 'How many files the Maintenance tools work on at once.',
    icon: Cpu,
  },
};

const DuplicateSettings: React.FC = () => {
  const scanOptions = useSettingsStore((s) => s.scanOptions);
  const setScanOptions = useSettingsStore((s) => s.setScanOptions);
  const resolutionStrategy = useSettingsStore((s) => s.resolutionStrategy);
  const setResolutionStrategy = useSettingsStore((s) => s.setResolutionStrategy);
  return (
    <SettingsPanel
      scanOptions={scanOptions}
      setScanOptions={setScanOptions}
      resolutionStrategy={resolutionStrategy}
      setResolutionStrategy={setResolutionStrategy}
    />
  );
};

const PerformanceSettings: React.FC = () => (
  <div className="px-6"><WorkersPanel /></div>
);

const SECTION_CONTENT: Record<SettingsSection, React.FC> = {
  duplicates: DuplicateSettings,
  relocation: RelocationSettings,
  performance: PerformanceSettings,
};

interface SettingsLayoutProps {
  section: SettingsSection;
  onSelect: (section: SettingsSection) => void;
}

/**
 * Every setting in one place, a section at a time: the menu on the left, the
 * chosen section on the right. Kept apart from the route so it renders
 * without a router.
 */
export const SettingsLayout: React.FC<SettingsLayoutProps> = ({ section, onSelect }) => {
  const meta = SECTION_META[section];
  const Content = SECTION_CONTENT[section];

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <PageHeader icon={SettingsIcon} title="Settings" />

      <div className="flex-1 flex overflow-hidden">
        <nav aria-label="Settings sections" className="w-56 flex-shrink-0 border-r-2 border-te-grey-300 bg-te-grey-200 p-te-md">
          <ul className="space-y-te-sm">
            {SETTINGS_SECTIONS.map((id) => {
              const item = SECTION_META[id];
              const active = id === section;
              return (
                <li key={id}>
                  <button
                    onClick={() => onSelect(id)}
                    aria-current={active ? 'page' : undefined}
                    className={`w-full flex items-center gap-te-md p-te-md rounded-te border-2 text-left
                      font-te-mono text-xs font-medium uppercase tracking-wider transition-colors
                      ${active
                        ? 'bg-te-orange text-te-cream border-te-orange'
                        : 'bg-te-cream text-te-grey-700 border-te-grey-300 hover:bg-te-grey-100 hover:border-te-grey-400'}`}
                  >
                    <item.icon className="w-4 h-4 flex-shrink-0" />
                    <span>{item.label}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        <section aria-label={meta.label} className="flex-1 overflow-y-auto bg-te-grey-100">
          <div className="px-6 pt-5">
            <h2 className="te-title">{meta.label}</h2>
            <p className="te-label normal-case mt-1">{meta.description}</p>
          </div>
          <div className="px-0 pb-6">
            <Content />
          </div>
        </section>
      </div>
    </div>
  );
};
