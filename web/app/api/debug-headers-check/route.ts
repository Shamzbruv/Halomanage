// TEMPORARY diagnostic route — verifies exactly which header Railway's edge
// forwards the real visitor IP in, before building network-restriction
// enforcement on top of it. Deleted immediately after this is confirmed;
// never intended to ship.
import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  return NextResponse.json({
    headers: Object.fromEntries(request.headers.entries()),
  });
}
