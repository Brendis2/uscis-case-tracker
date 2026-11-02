export type CaseStatusView = {
  formType: string | null;
  status: string;
  description: string | null;
  isDemo: boolean;
};

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

export function normalizeReceiptNumber(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const receipt = value.trim().toUpperCase();
  return /^[A-Z]{3}\d{10}$/.test(receipt) ? receipt : null;
}

export function parseCaseStatus(payload: unknown): CaseStatusView {
  const root = asRecord(payload);
  const status = asRecord(root.case_status ?? root);
  return {
    formType: asString(status.formType ?? status.form_type),
    status: asString(status.current_case_status_text_en ?? status.current_case_status ?? status.status) ?? 'Status unavailable',
    description: asString(status.current_case_status_desc_en ?? status.current_case_status_desc ?? status.status_description),
    isDemo: root.demo === true
  };
}

export function upstreamError(status: number): { httpStatus: number; message: string } {
  if (status === 401 || status === 403) {
    return { httpStatus: 502, message: `USCIS denied this app (HTTP ${status}). Check that this Team App has Case Status API - Sandbox enabled.` };
  }
  if (status === 400) {
    return { httpStatus: 400, message: 'USCIS rejected this receipt number (HTTP 400). Confirm it is a supported sandbox sample.' };
  }
  if (status === 503) {
    return { httpStatus: 503, message: 'The USCIS Case Status sandbox is temporarily unavailable (HTTP 503). Please retry later. If the USCIS Try It tool also returns 503, the issue is on their service.' };
  }
  return { httpStatus: 502, message: `USCIS returned HTTP ${status}. Please retry; if it continues, check the Team App sandbox access.` };
}
