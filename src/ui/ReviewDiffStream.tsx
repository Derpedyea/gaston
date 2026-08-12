import { CodeBracketIcon } from "@heroicons/react/16/solid";
import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import { FileDiff, type FileDiffProps } from "@pierre/diffs/react";
import { useCallback, useMemo } from "react";
import type { ReviewSessionSnapshot } from "../session";

const pierreDiffOptions = {
  theme: "pierre-dark",
  themeType: "dark",
  diffStyle: "unified",
  diffIndicators: "bars",
  lineDiffType: "word-alt",
  overflow: "scroll",
  stickyHeader: true,
  enableLineSelection: true,
} satisfies NonNullable<FileDiffProps<undefined>["options"]>;

export default function ReviewDiffStream({ session }: { session: ReviewSessionSnapshot }) {
  const diffs = useMemo(
    () => session.diff ? parsePatchFiles(session.diff, `review-${session.revision}`).flatMap((patch) => patch.files) : [],
    [session.diff, session.revision],
  );
  const fileByName = useMemo(
    () => new Map(session.files.map((file) => [file.path, file])),
    [session.files],
  );
  const renderMetadata = useCallback((fileDiff: FileDiffMetadata) => {
    const file = fileByName.get(fileDiff.name);
    if (!file) return null;
    return (
      <span className="flex items-center gap-2 font-mono tabular-nums">
        <span className="text-emerald-500">+{file.additions}</span>
        <span className="text-rose-500">−{file.deletions}</span>
      </span>
    );
  }, [fileByName]);
  const omitted = session.files.filter((file) => !file.patchAvailable);

  if (diffs.length === 0) {
    return (
      <div className="grid min-h-80 place-items-center p-8 text-center">
        <div className="max-w-sm">
          <CodeBracketIcon className="mx-auto size-4 fill-zinc-700" />
          <h3 className="pt-3 text-balance text-base font-medium text-zinc-300">Changes are not available yet</h3>
          <p className="pt-2 text-pretty text-base/7 text-zinc-600 sm:text-sm/6">The cumulative patch appears here after Gaston enters discovery.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3 p-3">
      {diffs.map((fileDiff) => (
        <FileDiff
          key={`${session.revision}:${fileDiff.prevName ?? ""}:${fileDiff.name}`}
          fileDiff={fileDiff}
          options={pierreDiffOptions}
          renderHeaderMetadata={renderMetadata}
          disableWorkerPool
        />
      ))}
      {omitted.length > 0 ? (
        <div className="rounded-lg bg-white/[0.025] p-4 text-base/7 text-zinc-500 inset-ring inset-ring-white/8 sm:text-sm/6">
          GitHub omitted patches for {omitted.map((file) => file.path).join(", ")} because they are binary or oversized.
        </div>
      ) : null}
    </div>
  );
}
