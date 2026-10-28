"use client";

import Link from "next/link";
import { CONTACT_EMAIL } from "@/lib/contact";

export default function Footer() {
  return (
    <footer className="bg-slate-900 text-slate-400">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex flex-col md:flex-row items-center justify-between gap-4">
          <div>
            <p className="text-white font-semibold">MultiLLM</p>
            <p className="text-sm mt-1">Unified sustainable AI platform</p>
          </div>
          <div className="text-sm flex flex-col md:items-end gap-2">
            <div className="flex gap-4">
              <a href={`mailto:${CONTACT_EMAIL}`} className="hover:text-white transition-colors">Contact</a>
              <Link href="/pricing" className="hover:text-white transition-colors">Pricing</Link>
              <Link href="/test-results" className="hover:text-white transition-colors">Test Results</Link>
            </div>
            <p>© {new Date().getFullYear()} MultiLLM. All rights reserved.</p>
            <p>Zero-carbon · Privacy-first · Multi-language</p>
          </div>
        </div>
      </div>
    </footer>
  );
}
