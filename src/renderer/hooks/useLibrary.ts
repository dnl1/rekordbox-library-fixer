import { useState, useEffect, useCallback } from 'react';
import type { LibraryData, ShowNotification } from '../types';
import { useSettingsStore } from '../stores/settingsStore';

export const useLibrary = (showNotification: ShowNotification) => {
  const [libraryPath, setLibraryPath] = useState<string>('');
  const [libraryData, setLibraryData] = useState<LibraryData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [startupComplete, setStartupComplete] = useState(false);

  const loadLibrary = useCallback(async (path: string): Promise<boolean> => {
    setIsLoading(true);
    try {
      setLibraryData(null);
      setLibraryPath(path);

      const result = await window.electronAPI.parseRekordboxLibrary(path);
      if (result.success) {
        setLibraryData(result.data);
        showNotification('success', `Loaded ${result.data.tracks.size} tracks from library`);
        return true;
      }
      showNotification('error', result.error || 'Failed to parse library');
      setLibraryPath('');
      return false;
    } catch {
      showNotification('error', 'Failed to load library');
      setLibraryPath('');
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [showNotification]);

  const clearStoredData = useCallback(() => {
    localStorage.removeItem('rekordboxLibraryPath');
    setLibraryPath('');
    setLibraryData(null);
    showNotification('info', 'Library data cleared');
  }, [showNotification]);

  // Persist library path whenever it changes
  useEffect(() => {
    if (libraryPath) {
      localStorage.setItem('rekordboxLibraryPath', libraryPath);
    }
  }, [libraryPath]);

  /**
   * Load straight from Rekordbox's own database instead of an exported XML.
   * Read-only: the app copies master.db and never writes to it.
   */
  const loadFromDb = useCallback(async (dbPath?: string): Promise<boolean> => {
    setIsLoading(true);
    try {
      // A machine can hold more than one (rekordbox 6 beside 7), so opening the
      // one that was actually clicked matters; detection is only the fallback.
      let target = dbPath;
      if (!target) {
        const detected = await window.electronAPI.detectRekordboxDb();
        if (!detected.found || !detected.dbPath) {
          showNotification('error', 'No rekordbox database found on this machine — use XML import instead.');
          return false;
        }
        target = detected.dbPath;
      }

      const key = useSettingsStore.getState().rekordboxDbKey;
      if (!key.trim()) {
        showNotification('error', 'The rekordbox database needs its key — click the database entry on the load screen to paste it.');
        return false;
      }

      setLibraryData(null);
      const result = await window.electronAPI.parseRekordboxDb({ dbPath: target, key });
      if (result.success && result.data) {
        setLibraryPath(target);
        setLibraryData(result.data);
        showNotification('success', `Loaded ${result.data.tracks.size} tracks from the rekordbox database`);
        return true;
      }
      showNotification('error', result.error || 'Could not read the rekordbox database');
      return false;
    } catch {
      showNotification('error', 'Could not read the rekordbox database');
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [showNotification]);

  /**
   * Open a library by path, whichever kind it is. Callers that reopen the
   * library after a write — the Backups tab, broken-entry removal, FLAC
   * conversion — used to get the XML loader, which sent a master.db through
   * the XML parser: the parse failed and the library closed under them.
   */
  const openLibrary = useCallback(
    (path: string): Promise<boolean> =>
      (path.toLowerCase().endsWith('.db') ? loadFromDb(path) : loadLibrary(path)),
    [loadFromDb, loadLibrary]
  );

  // The picker offers "All Files" too, and a master.db chosen there went to the
  // XML parser. It is the only way in when the database is not in the usual place.
  const selectLibrary = useCallback(async () => {
    try {
      const path = await window.electronAPI.selectRekordboxXML();
      if (path) {
        await openLibrary(path);
      }
    } catch {
      showNotification('error', 'Failed to select library file');
    }
  }, [openLibrary, showNotification]);

  // Startup: auto-load last library if the file is still reachable.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const run = async () => {
      const savedPath = localStorage.getItem('rekordboxLibraryPath');

      if (!savedPath) {
        setStartupComplete(true);
        return;
      }

      try {
        const { accessible } = await window.electronAPI.checkFileAccessible(savedPath);

        if (accessible) {
          // A .db path is rekordbox's own database, not an XML export: sending
          // it through the XML parser failed while the message still claimed
          // the library had been reopened.
          const reopened = await openLibrary(savedPath);
          if (reopened) {
            // Say so: restoring the last library silently made it easy to act
            // on a different one than you thought was open.
            showNotification('info', `Reopened your last library: ${savedPath}`);
          }
        } else {
          localStorage.removeItem('rekordboxLibraryPath');
        }
      } catch (err) {
        console.error('Startup auto-load failed:', err);
        localStorage.removeItem('rekordboxLibraryPath');
      } finally {
        setStartupComplete(true);
      }
    };

    run();
  }, []); // intentionally empty — runs once on mount only

  return {
    libraryPath,
    libraryData,
    isLoading,
    startupComplete,
    selectLibrary,
    loadLibrary,
    openLibrary,
    loadFromDb,
    clearStoredData,
    setLibraryData,
  };
};
