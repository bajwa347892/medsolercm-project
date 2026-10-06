import cuesJson from "./cues.json";

export const CUES = cuesJson;
export type ShotId = keyof typeof cuesJson.shots;
export const shotRange = (id: ShotId) => cuesJson.shots[id] as unknown as [number, number];
export const EV = cuesJson.events;
