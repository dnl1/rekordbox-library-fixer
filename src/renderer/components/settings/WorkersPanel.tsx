import React from 'react';
import { Cpu } from 'lucide-react';
import { useSettingsStore } from '../../stores/settingsStore';
import { MAX_WORKERS, MIN_WORKERS } from '../../../main/workerPool';

/**
 * How many files the Maintenance tools handle at once. Each worker runs its
 * own ffmpeg — converting, comparing or analysing one file — so more workers
 * finish a big library sooner, up to about the machine's core count, and
 * leave less of the machine for everything else meanwhile.
 */
export const WorkersPanel: React.FC = () => {
  const workers = useSettingsStore((s) => s.workers);
  const setWorkers = useSettingsStore((s) => s.setWorkers);
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 0 : 0;

  return (
    <div className="bg-white rounded-te shadow-sm p-te-md mt-te-md">
      <h3 className="font-semibold text-te-grey-800 mb-1 flex items-center gap-2">
        <Cpu className="w-4 h-4" /> Workers
      </h3>
      <p className="text-sm text-te-grey-500 font-te-mono mb-te-md">
        How many files are worked on at once by Convert FLAC, Clean up converted FLACs and Auto hot cues.
        More is faster on a big library, and leaves less of the computer for anything else meanwhile.
      </p>
      <label htmlFor="maintenance-workers" className="block text-xs font-medium text-te-grey-600 mb-1 uppercase">
        Workers: {workers}
      </label>
      <input
        id="maintenance-workers"
        type="range"
        min={MIN_WORKERS}
        max={MAX_WORKERS}
        step={1}
        value={workers}
        onChange={(e) => setWorkers(Number(e.target.value))}
        className="w-full accent-te-orange"
      />
      <p className="text-xs font-te-mono text-te-grey-400 mt-1">
        {cores > 0 ? `This computer has ${cores} cores. ` : ''}
        Converting to a slow or network drive gains little past two — the drive is the limit, not the processor.
      </p>
    </div>
  );
};
