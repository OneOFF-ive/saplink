export type SourceRead = { artifact_id: string; object_uri?: string; revision?: string; read_source?: true; total_characters: number;
  ranges: [number, number][] };

export function mergeSourceReads(previous: SourceRead[], changes: SourceRead[]): SourceRead[] {
  const values = new Map(previous.map(read => [read.artifact_id, read]));
  for (const change of changes) {
    const old = values.get(change.artifact_id);
    const ranges: [number, number][] = [];
    for (const [start, stop] of [...(old?.ranges ?? []), ...change.ranges].sort((a,b) => a[0]-b[0])) {
      const last = ranges.at(-1);
      const end = Math.min(stop, change.total_characters);
      if (start >= end) continue;
      if (last && start <= last[1]) last[1] = Math.max(last[1], end);
      else ranges.push([start, end]);
    }
    values.delete(change.artifact_id);
    values.set(change.artifact_id, { ...old, ...change, ranges: ranges.slice(-128) });
  }
  return [...values.values()].slice(-128);
}

export function sourceProgressText(reads: SourceRead[]) {
  return JSON.stringify(reads.slice(-8).map(read => ({ ...read,
    fully_provided: read.total_characters === 0 || (read.ranges.length === 1 && read.ranges[0][0] === 0 && read.ranges[0][1] === read.total_characters) })));
}
