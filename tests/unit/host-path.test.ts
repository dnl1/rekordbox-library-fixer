import { describe, it, expect } from 'vitest';
import { toHostPath, isWsl, wslMountRoot, type HostEnvironment } from '../../src/main/hostPath';
import { writePlansFor } from '../../src/main/conversionSettlement';

const wsl: HostEnvironment = {
  platform: 'linux', release: '6.18.33.1-microsoft-standard-WSL2', mountRoot: '/mnt/',
};

describe('isWsl', () => {
  it('knows WSL by its kernel or its distro variable', () => {
    expect(isWsl(wsl)).toBe(true);
    expect(isWsl({ platform: 'linux', release: '6.8.0-generic', wslDistro: 'Ubuntu' })).toBe(true);
    expect(isWsl({ platform: 'linux', release: '6.8.0-generic' })).toBe(false);
    expect(isWsl({ platform: 'win32', release: '10.0.26100' })).toBe(false);
  });
});

describe('toHostPath', () => {
  it('reaches a Windows drive through /mnt under WSL', () => {
    // rekordbox on Windows stores forward slashes; either spelling is accepted.
    expect(toHostPath('C:/Users/dj/Songs/A.flac', wsl)).toBe('/mnt/c/Users/dj/Songs/A.flac');
    expect(toHostPath('D:\\Music\\B.flac', wsl)).toBe('/mnt/d/Music/B.flac');
  });

  it('reads the drive out of an XML location decoded on Linux', () => {
    // file://localhost/C:/x decodes to /C:/x on Linux.
    expect(toHostPath('/C:/Users/dj/A.flac', wsl)).toBe('/mnt/c/Users/dj/A.flac');
  });

  it('leaves Linux paths, streaming ids and other systems alone', () => {
    expect(toHostPath('/home/dj/A.flac', wsl)).toBe('/home/dj/A.flac');
    expect(toHostPath('tidal:tracks:123', wsl)).toBe('tidal:tracks:123');
    expect(toHostPath('C:/Users/dj/A.flac', { ...wsl, platform: 'win32' })).toBe('C:/Users/dj/A.flac');
    expect(toHostPath('C:/Users/dj/A.flac', { ...wsl, release: '6.8.0-generic' })).toBe('C:/Users/dj/A.flac');
  });

  it('follows a custom automount root', () => {
    expect(toHostPath('C:/A.flac', { ...wsl, mountRoot: '/win/' })).toBe('/win/c/A.flac');
  });
});

describe('wslMountRoot', () => {
  it('defaults to /mnt/', () => {
    expect(wslMountRoot(null)).toBe('/mnt/');
    expect(wslMountRoot('[boot]\nsystemd=true\n')).toBe('/mnt/');
  });

  it('reads root under [automount] only', () => {
    expect(wslMountRoot('[automount]\nenabled = true\nroot = /win\n')).toBe('/win/');
    expect(wslMountRoot('[automount]\nroot = "/drives/" # comment\n')).toBe('/drives/');
    expect(wslMountRoot('[network]\nroot = /nope\n')).toBe('/mnt/');
  });
});

describe('writePlansFor under WSL', () => {
  it('writes the library back in the spelling rekordbox stored', () => {
    const library = new Map([['/mnt/c/Users/dj/A.flac', 'C:/Users/dj/A.flac']]);
    const [plan] = writePlansFor([{
      trackIds: ['t1'], oldLocation: '/mnt/c/Users/dj/A.flac', newLocation: '/mnt/c/Users/dj/A.aiff',
      format: 'aiff', size: 1, sampleRate: 44100, bitDepth: 16, bitRate: 1411,
    }], (host) => library.get(host) ?? host);
    expect(plan.oldLocation).toBe('C:/Users/dj/A.flac');
    expect(plan.newLocation).toBe('C:/Users/dj/A.aiff');
  });
});
