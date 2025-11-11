import { HistoryDataProvider } from "./types";
import { PointReadingsProvider } from "./point-readings-provider";

export class HistoryProviderFactory {
  private static pointReadingsProvider = new PointReadingsProvider();

  /**
   * Get the history data provider.
   * Always returns PointReadingsProvider as it's now the only provider.
   */
  static getProvider(): HistoryDataProvider {
    return this.pointReadingsProvider;
  }
}
