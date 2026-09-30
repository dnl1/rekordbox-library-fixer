import React, { useEffect, useState } from 'react';
import { CheckCircle, AlertCircle } from 'lucide-react';

/**
 * The Navidrome server tracks are imported from. The password goes to the
 * main process once, is checked against the server, and is kept there
 * encrypted by the system keychain; this form never gets it back — only
 * whether one is saved.
 */
export const NavidromeSettings: React.FC = () => {
  const [url, setUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [hasPassword, setHasPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let active = true;
    window.electronAPI.navidromeConnection?.().then((res) => {
      if (!active || !res?.success || !res.data) { return; }
      setUrl(res.data.url);
      setUsername(res.data.username);
      setHasPassword(res.data.hasPassword);
    }).catch(() => { /* nothing saved yet */ });
    return () => { active = false; };
  }, []);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setStatus(null);
    const res = await window.electronAPI.navidromeSaveConnection({ url, username, password });
    setBusy(false);
    if (res.success) {
      setPassword('');
      setHasPassword(true);
      setStatus({ ok: true, text: `Connected${res.data?.serverVersion ? ` — Navidrome ${res.data.serverVersion}` : ''}. Saved.` });
    } else {
      setStatus({ ok: false, text: res.error ?? 'Could not connect.' });
    }
  };

  const forget = async () => {
    await window.electronAPI.navidromeForgetConnection();
    setUrl(''); setUsername(''); setPassword(''); setHasPassword(false);
    setStatus({ ok: true, text: 'Forgotten. Nothing about the server is kept any more.' });
  };

  return (
    <form onSubmit={save} className="px-6 pt-4 space-y-te-md max-w-xl">
      <div>
        <label htmlFor="navidrome-url" className="block text-xs font-medium text-te-grey-600 mb-1 uppercase">Server address</label>
        <input
          id="navidrome-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://music.example.com"
          className="input w-full font-te-mono text-sm" autoComplete="url" spellCheck={false}
        />
      </div>
      <div>
        <label htmlFor="navidrome-username" className="block text-xs font-medium text-te-grey-600 mb-1 uppercase">Username</label>
        <input
          id="navidrome-username" value={username} onChange={(e) => setUsername(e.target.value)}
          className="input w-full font-te-mono text-sm" autoComplete="username" spellCheck={false}
        />
      </div>
      <div>
        <label htmlFor="navidrome-password" className="block text-xs font-medium text-te-grey-600 mb-1 uppercase">Password</label>
        <input
          id="navidrome-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
          placeholder={hasPassword ? 'Saved — leave empty to keep it' : ''}
          className="input w-full font-te-mono text-sm" autoComplete="current-password"
        />
        <p className="text-xs font-te-mono text-te-grey-400 mt-1">
          Kept on this computer only, encrypted by the system keychain. The server receives a one-time
          token, never the password.
        </p>
      </div>

      <div className="flex gap-2">
        <button type="submit" disabled={busy || !url.trim() || !username.trim() || (!password && !hasPassword)} className="btn-primary text-xs disabled:opacity-40">
          {busy ? 'Connecting…' : 'Test and save'}
        </button>
        {(hasPassword || url) && (
          <button type="button" onClick={forget} className="btn-ghost text-xs">Forget</button>
        )}
      </div>

      {status && (
        <p className={`text-xs font-te-mono flex items-center gap-1 ${status.ok ? 'text-te-green-600' : 'text-te-red-500'}`}>
          {status.ok ? <CheckCircle size={12} /> : <AlertCircle size={12} />} {status.text}
        </p>
      )}
    </form>
  );
};
