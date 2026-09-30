import React, { useState } from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import { TrackRelocatorSettings } from '../TrackRelocatorSettings';

/**
 * The Track Relocator's search settings, fed straight from the store: the
 * relocator reads the same options when it runs, so there is nothing to sync.
 */
export const RelocationSettings: React.FC = () => {
  const relocationOptions = useSettingsStore((s) => s.relocationOptions);
  const addRelocationSearchPath = useSettingsStore((s) => s.addRelocationSearchPath);
  const removeRelocationSearchPath = useSettingsStore((s) => s.removeRelocationSearchPath);
  const [newSearchPath, setNewSearchPath] = useState('');

  return (
    <TrackRelocatorSettings
      searchOptions={relocationOptions}
      newSearchPath={newSearchPath}
      setNewSearchPath={setNewSearchPath}
      addSearchPath={() => {
        if (newSearchPath.trim()) {
          addRelocationSearchPath(newSearchPath.trim());
          setNewSearchPath('');
        }
      }}
      removeSearchPath={removeRelocationSearchPath}
    />
  );
};
