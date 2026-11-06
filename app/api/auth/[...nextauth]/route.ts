import NextAuth from "next-auth";
import { authOptions } from "@/lib/auth/options";

export const dynamic = "force-dynamic";

const handler = (req: Request, ctx: unknown) => NextAuth(req as never, ctx as never, authOptions());
export { handler as GET, handler as POST };
