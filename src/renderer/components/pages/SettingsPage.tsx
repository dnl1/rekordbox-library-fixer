import React from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { SettingsLayout } from '../settings/SettingsLayout';
import { DEFAULT_SETTINGS_SECTION } from '../../settings/sections';

/** The section lives in the URL, so a page can open Settings where it needs to. */
export const SettingsPage: React.FC = () => {
  const { section } = useSearch({ from: '/settings' });
  const navigate = useNavigate();
  return (
    <SettingsLayout
      section={section ?? DEFAULT_SETTINGS_SECTION}
      onSelect={(next) => navigate({ to: '/settings', search: { section: next } })}
    />
  );
};
