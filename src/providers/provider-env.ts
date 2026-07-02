// Env handed to exec providers across every verb that runs one (see/enhance/
// watch/listen + scan/monitor --pipe): the case media output dir plus the
// system ffmpeg/ffprobe, so a provider can extract frames / write enhanced
// media into the case without a system ffmpeg, and not write outside it.
import { FFMPEG_PATH, FFPROBE_PATH } from "../media/ffmpeg.js";

export function providerEnv(mediaDir: string, caseDir?: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    OVERCAST_MEDIA_DIR: mediaDir,
    // the case root, for providers that resolve case-relative inputs (e.g. a
    // lens query naming a crop output while scan runs with --case elsewhere)
    ...(caseDir ? { OVERCAST_CASE_DIR: caseDir } : {}),
    OVERCAST_FFMPEG: FFMPEG_PATH,
    OVERCAST_FFPROBE: FFPROBE_PATH,
  };
}
