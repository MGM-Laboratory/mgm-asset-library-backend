import { Injectable, OnModuleInit } from '@nestjs/common';
import { stat } from 'node:fs/promises';

/**
 * Reports the freshness of ClamAV's signature database. Worker-mode
 * `/readyz` surfaces this so ops can spot a stuck freshclam.
 */
@Injectable()
export class AvDefinitionsService implements OnModuleInit {
  private lastUpdate: Date | null = null;
  /** Path to the daily.{cvd,cld} file ClamAV ships. Default Debian path. */
  private readonly probePath = '/var/lib/clamav/daily.cvd';

  async onModuleInit(): Promise<void> {
    await this.refresh();
    // Re-probe on a 30-minute timer; freshclam runs every 12 h by default.
    setInterval(() => void this.refresh(), 30 * 60 * 1000).unref();
  }

  lastUpdatedAt(): Date | null {
    return this.lastUpdate;
  }

  private async refresh(): Promise<void> {
    for (const path of [this.probePath, '/var/lib/clamav/daily.cld', '/var/lib/clamav/main.cvd']) {
      try {
        const stats = await stat(path);
        this.lastUpdate = stats.mtime;
        return;
      } catch {
        // try the next candidate path
      }
    }
    this.lastUpdate = null;
  }
}
