export type DiscoverableReportSource = "signup_forms" | "welcome_flow" | "customer_split";
export type SourceDiscoveryStatus = "AUTH_REQUIRED" | "INSPECTED" | "SOURCE_VISIBLE_NO_ROWS" | "SOURCE_NOT_VISIBLE";

export interface SourceDiscoveryEvidence {
  source: DiscoverableReportSource;
  authenticationRequired?: boolean;
  mainText: string;
  tableHeaders: readonly string[];
  rowCount: number;
}

export interface SourceDiscoveryClassification {
  status: SourceDiscoveryStatus;
  reason: string | null;
}

/** Classify only visible listing/report evidence; never infer targets from object editors. */
export function classifySourceDiscovery(evidence: SourceDiscoveryEvidence): SourceDiscoveryClassification {
  if (evidence.authenticationRequired) return { status: "AUTH_REQUIRED", reason: "Authentication is required." };

  const hasRows = evidence.tableHeaders.length > 0 && evidence.rowCount > 0;
  if (evidence.source === "signup_forms") {
    const hasPerformanceColumns = ["Name", "Submit rate", "Total revenue"].every((header) => evidence.tableHeaders.includes(header));
    if (hasPerformanceColumns && evidence.rowCount === 0) {
      return { status: "SOURCE_VISIBLE_NO_ROWS", reason: "The account-level forms listing rendered its performance columns but contained zero form rows; no form capture or target selection is inferred." };
    }
    return hasPerformanceColumns && hasRows
      ? { status: "INSPECTED", reason: null }
      : { status: "SOURCE_NOT_VISIBLE", reason: "The configured Forms listing did not expose usable performance rows; individual forms are intentionally not opened." };
  }

  if (evidence.source === "welcome_flow") {
    return hasRows
      ? { status: "INSPECTED", reason: null }
      : { status: "SOURCE_NOT_VISIBLE", reason: "The configured Flows listing did not expose usable flow rows; individual flows are intentionally not opened." };
  }

  if (evidence.source === "customer_split") {
    return hasRows
      ? { status: "INSPECTED", reason: null }
      : { status: "SOURCE_NOT_VISIBLE", reason: "The configured Lists & Segments listing did not expose usable segment rows; individual segments are intentionally not opened." };
  }

  return { status: "SOURCE_NOT_VISIBLE", reason: "Unsupported report source." };
}
