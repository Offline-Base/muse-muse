"use client";

import { useEffect, useState } from "react";
import { AppGuide, type HelloExample } from "@/components/vibe/AppGuide";
import type { PageFiles } from "@/components/vibe/apps";
import { DevicePicker } from "@/components/vibe/DevicePicker";
import { EMPTY_PICKER, pickerReady, prefill, profileOf, type PickerState } from "@/components/vibe/picker";
import { readSignals } from "@/components/vibe/signals";
import { VerdictCard, type TryLiveWhere } from "@/components/vibe/VerdictCard";
import type { QuantLevel } from "@/lib/train/local-files";
import { DEFAULT_DOWNLOAD_MBPS, detectDevice, pickBuild, rateBuilds, type Detected } from "@/lib/vibe/device";

export interface LocalGuideProps {
  /** toPageFiles of localFilesFor's answer: only what the guide uses. */
  files: PageFiles;
  hello: HelloExample | null;
  live: TryLiveWhere;
  /** The flash drive request for this model while drives are on (Feature 6), else null. */
  driveHref?: string | null;
  /** What the picker starts from, before the browser's own signals: for tests, and nothing else. */
  initial?: PickerState;
  /** Where "Stuck?" says to write for help (DRIVE_CONTACT_EMAIL), or null. */
  help?: string | null;
  /**
   * False for the flash drive request (Feature 6): the picker and the verdict only, so nobody orders a drive their
   * computer can't run, without the download's time and disk or the app guide.
   */
  guide?: boolean;
}

/**
 * The run-locally page's interactive part (docs/VIBE_TUNING.md, Features 2 and 5): Your computer, the verdict, and Get
 * it running for the build that fits. The browser's signals are read once the page mounts and only pre-fill the picker;
 * they stay in this component's state and are never sent, and the person can change every part of them.
 */
export function LocalGuide({ files, hello, live, driveHref = null, initial = EMPTY_PICKER, help = null, guide = true }: LocalGuideProps) {
  const [picker, setPicker] = useState<PickerState>(initial);
  const [detected, setDetected] = useState<Detected | null>(null);
  const [level, setLevel] = useState<QuantLevel | null>(null);
  const [mbps, setMbps] = useState(DEFAULT_DOWNLOAD_MBPS);
  const [diskFor, setDiskFor] = useState<QuantLevel | null>(null);

  useEffect(() => {
    let gone = false;
    readSignals()
      .then((s) => {
        if (gone) return;
        const d = detectDevice(s);
        setDetected(d);
        setPicker((p) => prefill(p, d));
      })
      .catch(() => {
        // A browser that refuses every signal just leaves the picker to the person.
      });
    return () => {
      gone = true;
    };
  }, []);

  const ready = pickerReady(picker);
  const profile = profileOf(picker);
  const rated = ready ? rateBuilds(profile, files.files) : null;
  const picked = ready ? pickBuild(profile, files.files) : null;
  const chosen = (level && rated?.find((v) => v.file?.level === level && v.fit !== "no")) || picked;
  // Only a build that runs here gets a guide: one that won't run gets Try it live instead.
  const guideFile = chosen?.file ?? null;

  return (
    <>
      <DevicePicker
        state={picker}
        detected={detected}
        onChange={(next) => {
          setPicker(next);
          setLevel(null);
        }}
      />
      <VerdictCard
        verdict={chosen}
        pickedLevel={picked?.file?.level ?? null}
        rated={rated}
        onLevel={setLevel}
        mbps={mbps}
        onMbps={setMbps}
        diskOk={Boolean(chosen?.file && diskFor === chosen.file.level)}
        onDiskOk={(ok) => setDiskFor(ok && chosen?.file ? chosen.file.level : null)}
        live={live}
        driveHref={driveHref}
        download={guide}
      />
      {guide && guideFile && picker.kind ? (
        <AppGuide
          key={picker.kind}
          kind={picker.kind}
          file={guideFile}
          files={files}
          hello={hello}
          nvidia={profile.gpu?.vendor === "nvidia"}
          diskOk={diskFor === guideFile.level}
          help={help}
        />
      ) : null}
    </>
  );
}
