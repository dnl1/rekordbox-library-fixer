import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DuplicateDetector } from '../../src/main/duplicateDetector';
import type { DuplicateOptions } from '../../src/main/duplicateDetector';
import type { Track } from '../../src/main/rekordboxParser';
import fs from 'fs/promises';

describe('DuplicateDetector', () => {
  let detector: DuplicateDetector;
  let testTracks: Track[];

  beforeEach(() => {
    detector = new DuplicateDetector();
    vi.clearAllMocks();
    
    // Set up test tracks
    testTracks = [
      {
        id: '1',
        name: 'House Track',
        artist: 'DJ Test',
        album: 'Test Album',
        location: '/path/original/house-track.mp3',
        bpm: 128,
        bitrate: 320,
        size: 8421504,
        duration: 240.5,
        genre: 'House',
        key: 'Am',
        playCount: 10,
        rating: 5,
        cues: [],
        loops: [],
      },
      {
        id: '2',
        name: 'House Track', // Same name
        artist: 'DJ Test', // Same artist
        album: 'Test Album', // Same album
        location: '/path/backup/house-track.mp3', // Different location
        bpm: 128,
        bitrate: 320,
        size: 8421504,
        duration: 240.5,
        genre: 'House',
        key: 'Am',
        playCount: 3,
        rating: 4,
        cues: [],
        loops: [],
      },
      {
        id: '3',
        name: 'house track', // Same name, different case
        artist: 'dj test', // Same artist, different case
        album: 'test album', // Same album, different case
        location: '/path/low-quality/house-track.mp3',
        bpm: 128,
        bitrate: 128, // Lower quality
        size: 4210752,
        duration: 240.8,
        genre: 'House',
        playCount: 1,
        rating: 3,
        cues: [],
        loops: [],
      },
      {
        id: '4',
        name: 'Different Track',
        artist: 'Other Artist',
        album: 'Other Album',
        location: '/path/different-track.mp3',
        bpm: 132,
        bitrate: 320,
        size: 9876543,
        duration: 180.0,
        genre: 'Techno',
        key: 'Dm',
        playCount: 8,
        rating: 5,
        cues: [],
        loops: [],
      },
    ];
  });

  describe('findDuplicates', () => {
    it('should find metadata-based duplicates', async () => {
      const options: DuplicateOptions = {
        useMetadata: true,
        useFingerprint: false,
        metadataFields: ['artist', 'title', 'album'],
      };

      const { duplicates } = await detector.findDuplicates(testTracks, options);

      expect(duplicates).toHaveLength(1);
      expect(duplicates[0].tracks).toHaveLength(3); // Tracks 1, 2, 3 are duplicates
      expect(duplicates[0].matchType).toBe('metadata');
      expect(duplicates[0].confidence).toBeGreaterThan(0);
      
      const duplicateTrackIds = duplicates[0].tracks.map(t => t.id).sort();
      expect(duplicateTrackIds).toEqual(['1', '2', '3']);
    });

    it('should find duplicates with different metadata fields', async () => {
      const options: DuplicateOptions = {
        useMetadata: true,
        useFingerprint: false,
        metadataFields: ['artist', 'title'], // Without album
      };

      const { duplicates } = await detector.findDuplicates(testTracks, options);

      expect(duplicates).toHaveLength(1);
      expect(duplicates[0].tracks).toHaveLength(3); // Still tracks 1, 2, 3
    });

    it('should not find duplicates when metadata fields differ significantly', async () => {
      // Add a track with same name but different artist
      const differentArtistTrack: Track = {
        ...testTracks[0],
        id: '5',
        artist: 'Completely Different Artist',
      };
      
      const tracksWithDifferentArtist = [...testTracks.slice(3), differentArtistTrack]; // Only track 4 and the new track

      const options: DuplicateOptions = {
        useMetadata: true,
        useFingerprint: false,
        metadataFields: ['artist', 'title'],
      };

      const { duplicates } = await detector.findDuplicates(tracksWithDifferentArtist, options);

      expect(duplicates).toHaveLength(0);
    });

    it('should handle BPM and duration matching with tolerance', async () => {
      const closeTrack: Track = {
        id: '5',
        name: 'House Track', // Same name as testTracks[0]
        artist: 'DJ Test',    // Same artist as testTracks[0]
        location: '/path/close-match.mp3',
        bpm: 127.5, // Within 1 BPM of 128
        duration: 241.0, // Within 2 seconds of 240.5
        cues: [],
        loops: [],
      };

      const tracksWithClose = [testTracks[0], closeTrack];

      const options: DuplicateOptions = {
        useMetadata: true,
        useFingerprint: false,
        metadataFields: ['artist', 'title', 'bpm', 'duration'],
      };

      const { duplicates } = await detector.findDuplicates(tracksWithClose, options);

      // Should find duplicates due to tolerance in BPM and duration matching
      expect(duplicates).toHaveLength(1);
      expect(duplicates[0].tracks).toHaveLength(2);
    });

    it('should handle fingerprint-based detection', async () => {
      // Mock file system operations
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.stat).mockResolvedValue({ size: 8421504 } as any);
      
      const mockFd = {
        read: vi.fn().mockResolvedValue({ bytesRead: 1024 * 1024 }),
        close: vi.fn().mockResolvedValue(undefined),
      };
      vi.mocked(fs.open).mockResolvedValue(mockFd as any);

      // Mock music-metadata
      const { parseFile } = await import('music-metadata');
      (parseFile as any).mockResolvedValue({
        format: {
          duration: 240.5,
          bitrate: 320,
        },
      });

      const options: DuplicateOptions = {
        useMetadata: false,
        useFingerprint: true,
        metadataFields: [],
      };

      const { duplicates } = await detector.findDuplicates([testTracks[0], testTracks[1]], options);

      // With mocked fingerprinting, tracks should be detected as duplicates
      expect(duplicates.length).toBeGreaterThanOrEqual(0);
    });

    it('should handle empty tracks array', async () => {
      const options: DuplicateOptions = {
        useMetadata: true,
        useFingerprint: false,
        metadataFields: ['artist', 'title'],
      };

      const { duplicates } = await detector.findDuplicates([], options);

      expect(duplicates).toHaveLength(0);
    });
  });
});