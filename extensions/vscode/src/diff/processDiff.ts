import { Core } from "core/core";
import { DataLogger } from "core/data/log";
import { myersDiff } from "core/diff/myers";
import { localPathOrUriToPath } from "core/util/pathToUri";
import * as path from "path";
import * as vscode from "vscode";

import { ContinueGUIWebviewViewProvider } from "../ContinueGUIWebviewViewProvider";
import { DecisionLog } from "../authorship/DecisionLog";
import {
  buildChangeSummary,
  ensureDecisionForChange,
  getAuthorshipConfig,
} from "../authorship/authorship";
import { editOutcomeTracker } from "../extension/EditOutcomeTracker";
import { VsCodeIde } from "../VsCodeIde";

import { VerticalDiffManager } from "./vertical/manager";

export async function processDiff(
  action: "accept" | "reject",
  sidebar: ContinueGUIWebviewViewProvider,
  ide: VsCodeIde,
  core: Core,
  verticalDiffManager: VerticalDiffManager,
  newFileUri?: string,
  streamId?: string,
  toolCallId?: string,
) {
  let newOrCurrentUri = newFileUri;
  if (!newOrCurrentUri) {
    const currentFile = await ide.getCurrentFile();
    newOrCurrentUri = currentFile?.path;
  }
  if (!newOrCurrentUri) {
    console.warn(
      `No file provided or current file open while attempting to resolve diff`,
    );
    return;
  }

  await ide.openFile(newOrCurrentUri);

  const authorshipConfig = getAuthorshipConfig();
  const enforceAuthorship =
    authorshipConfig.enabled || authorshipConfig.docsOnly;
  let decisionResult = null;
  let changeSummary = null;
  let filesTouched: string[] = [];
  if (action === "accept" && enforceAuthorship) {
    const blocks =
      verticalDiffManager.fileUriToCodeLens.get(newOrCurrentUri) ?? [];
    const linesAdded = blocks.reduce((sum, block) => sum + block.numGreen, 0);
    const linesRemoved = blocks.reduce((sum, block) => sum + block.numRed, 0);
    const isMultiFile = verticalDiffManager.fileUriToCodeLens.size > 1;
    changeSummary = buildChangeSummary({
      fileUri: newOrCurrentUri,
      linesAdded,
      linesRemoved,
      isNewFile: false,
      isMultiFile,
    });

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(
      vscode.Uri.parse(newOrCurrentUri),
    );
    const fileUris = isMultiFile
      ? Array.from(verticalDiffManager.fileUriToCodeLens.keys())
      : [newOrCurrentUri];
    filesTouched = fileUris.map((uri) => {
      const filePath = localPathOrUriToPath(uri);
      return workspaceFolder?.uri.fsPath
        ? path.relative(workspaceFolder.uri.fsPath, filePath)
        : filePath;
    });

    decisionResult = await ensureDecisionForChange(
      changeSummary,
      authorshipConfig,
      {
        filesTouched,
        repoRootPath: workspaceFolder?.uri.fsPath,
      },
    );
    if (!decisionResult) {
      return;
    }
  }

  // If streamId is not provided, try to get it from the VerticalDiffManager
  if (!streamId) {
    streamId = verticalDiffManager.getStreamIdForFile(newOrCurrentUri);
  }

  // Clear vertical diffs depending on action
  verticalDiffManager.clearForfileUri(newOrCurrentUri, action === "accept");
  if (action === "reject") {
    // this is so that IDE reject diff command can also cancel apply
    core.invoke("cancelApply", undefined);
  }

  if (streamId) {
    // Capture file content before save to detect autoformatting
    const preSaveContent = await ide.readFile(newOrCurrentUri);

    // Record the edit outcome before updating the apply state
    await editOutcomeTracker.recordEditOutcome(
      streamId,
      action === "accept",
      DataLogger.getInstance(),
    );

    // Save the file
    await ide.saveFile(newOrCurrentUri);

    // Capture file content after save to detect autoformatting
    const postSaveContent = await ide.readFile(newOrCurrentUri);

    // Detect autoformatting by comparing normalized content
    let autoFormattingDiff: string | undefined;
    const normalizedPreSave = preSaveContent.trim();
    const normalizedPostSave = postSaveContent.trim();

    if (normalizedPreSave !== normalizedPostSave) {
      // Auto-formatting was applied by the editor
      const diffLines = myersDiff(preSaveContent, postSaveContent);
      autoFormattingDiff = diffLines
        .map((line) => {
          switch (line.type) {
            case "old":
              return `-${line.line}`;
            case "new":
              return `+${line.line}`;
            case "same":
              return ` ${line.line}`;
          }
        })
        .join("\n");
    }

    await sidebar.webviewProtocol.request("updateApplyState", {
      fileContent: postSaveContent, // Use post-save content
      filepath: newOrCurrentUri,
      streamId,
      status: "closed",
      numDiffs: 0,
      toolCallId,
      autoFormattingDiff, // Include autoformatting diff
    });
  } else {
    // Save the file even if no streamId
    await ide.saveFile(newOrCurrentUri);
  }

  if (
    action === "accept" &&
    authorshipConfig.enabled &&
    decisionResult &&
    changeSummary
  ) {
    const decisionLog = new DecisionLog(ide);
    await decisionLog.record(
      {
        operationType: "applyDiff",
        predictability: decisionResult.predictability,
        decisionNote: decisionResult.decisionNote,
        filesTouched,
        diffStats: {
          linesAdded: changeSummary.linesAdded,
          linesRemoved: changeSummary.linesRemoved,
        },
        aiActionSummary: `Applied AI diff to ${filesTouched.join(", ") || "file"}`,
        planPath: decisionResult.planPath,
        planTitle: decisionResult.planTitle,
        approvals: decisionResult.approvals,
        verification: decisionResult.verification,
      },
      newOrCurrentUri,
    );
  }
}
