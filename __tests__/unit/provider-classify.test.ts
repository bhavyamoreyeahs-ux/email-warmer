/**
 * Unit tests for header-based message classification (lib/mailboxes/providers/classify.ts).
 * Covers every rule, the negatives (ordinary mail is not an event) and the
 * guarantee that subject text never appears in a signal.
 */
import { describe, expect, it } from "vitest";
import {
  classifyMessage,
  extractAddress,
  extractAddresses,
  isFromMailbox,
  type ClassifyInput,
} from "@/lib/mailboxes/providers/classify";

const MAILBOX = "sales@acme.test";
const WHEN = new Date("2026-10-20T10:00:00Z");

function inbound(overrides: Partial<ClassifyInput>): ClassifyInput {
  return {
    providerMessageRef: "msg-1",
    occurredAt: WHEN,
    direction: "inbound",
    from: '"Pat Prospect" <pat@prospect.test>',
    to: [MAILBOX],
    subject: "Quarterly planning",
    headers: {},
    mailboxAddress: MAILBOX,
    ...overrides,
  };
}

describe("address helpers", () => {
  it("extracts display-name and bare addresses, lower-cased", () => {
    expect(extractAddress('"Pat Prospect" <Pat@Prospect.TEST>')).toBe("pat@prospect.test");
    expect(extractAddress("Pat <pat@prospect.test>")).toBe("pat@prospect.test");
    expect(extractAddress("<pat@prospect.test>")).toBe("pat@prospect.test");
    expect(extractAddress("pat@prospect.test")).toBe("pat@prospect.test");
    expect(extractAddress('"weird@name.test" <real@prospect.test>')).toBe("real@prospect.test");
    expect(extractAddress("no address here")).toBeNull();
    expect(extractAddress(null)).toBeNull();
  });

  it("splits address lists outside quotes", () => {
    expect(extractAddresses('"Doe, Jane" <jane@x.test>, bob@y.test; <c@z.test>')).toEqual([
      "jane@x.test",
      "bob@y.test",
      "c@z.test",
    ]);
    expect(extractAddresses("")).toEqual([]);
  });

  it("matches the mailbox address case-insensitively", () => {
    expect(isFromMailbox('"Sales" <SALES@acme.test>', MAILBOX)).toBe(true);
    expect(isFromMailbox("other@acme.test", MAILBOX)).toBe(false);
    expect(isFromMailbox(null, MAILBOX)).toBe(false);
  });
});

describe("classifyMessage", () => {
  it("outbound mail is 'sent' with recipient count and no counterparty", () => {
    const s = classifyMessage({
      ...inbound({}),
      direction: "outbound",
      from: MAILBOX,
      to: ["a@x.test", "b@y.test", "c@z.test"],
    });
    expect(s).toMatchObject({
      category: "sent",
      confidence: "high",
      counterpartyAddress: null,
      diagnosticCode: null,
      metadata: { recipientCount: 3 },
    });
  });

  it("ARF feedback reports are complaints", () => {
    const s = classifyMessage(
      inbound({
        from: "fbl@isp.test",
        subject: "Abuse report",
        headers: { "content-type": 'multipart/report; report-type="feedback-report"; boundary="x"' },
      }),
    );
    expect(s).toMatchObject({
      category: "complaint",
      confidence: "high",
      classificationBasis: "header:Content-Type report-type=feedback-report",
    });
  });

  it("Google sending-limit notices are sending_limit", () => {
    const google = classifyMessage(
      inbound({ from: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>", subject: "You have reached a limit for sending mail" }),
    );
    expect(google).toMatchObject({ category: "sending_limit", confidence: "high" });
    const noreply = classifyMessage(
      inbound({ from: "mail-noreply@google.com", subject: "You have reached a limit for sending mail" }),
    );
    expect(noreply?.category).toBe("sending_limit");
    const otherDaemon = classifyMessage(
      inbound({ from: "MAILER-DAEMON@mx.other.test", subject: "You have reached a limit for sending mail" }),
    );
    expect(otherDaemon).toMatchObject({ category: "sending_limit", confidence: "medium" });
  });

  it("a human writing the sending-limit phrase is not a sending-limit notice", () => {
    expect(classifyMessage(inbound({ subject: "You have reached a limit for sending mail" }))).toBeNull();
  });

  it("Microsoft 'not a valid sender' NDRs are bounces, not sending_limit", () => {
    const s = classifyMessage(
      inbound({ from: '"Microsoft Outlook" <postmaster@acme.onmicrosoft.com>', subject: "Undeliverable: Intro call" }),
    );
    expect(s?.category).toBe("hard_bounce");
  });

  describe("DSN / NDR", () => {
    it("Gmail failure DSN with X-Failed-Recipients is a high-confidence hard bounce", () => {
      const s = classifyMessage(
        inbound({
          from: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
          subject: "Delivery Status Notification (Failure)",
          headers: { "x-failed-recipients": "Gone@Prospect.test", "auto-submitted": "auto-replied" },
        }),
      );
      expect(s).toMatchObject({
        category: "hard_bounce",
        confidence: "high",
        counterpartyAddress: "gone@prospect.test",
        diagnosticCode: null,
        metadata: { failedRecipientCount: 1 },
      });
      expect(s?.classificationBasis).toContain("header:X-Failed-Recipients");
      expect(s?.classificationBasis).toContain("subject-pattern:delivery-failure");
    });

    it("failure subjects without the header are medium confidence", () => {
      for (const subject of [
        "Undeliverable: Intro call",
        "Undelivered Mail Returned to Sender",
        "Mail delivery failed: returning message to sender",
        "Returned mail: see transcript for details",
        "failure notice",
      ]) {
        const s = classifyMessage(inbound({ from: "MAILER-DAEMON@mx.prospect.test", subject }));
        expect(s, subject).toMatchObject({ category: "hard_bounce", confidence: "medium", counterpartyAddress: null });
      }
    });

    it("delay notices are soft bounces (delay checked before 'Returned mail')", () => {
      for (const subject of [
        "Delivery Status Notification (Delay)",
        "Delivery delayed: Intro call",
        "Delayed Mail (still being retried)",
        "Returned mail: Warning: could not send message for past 4 hours",
      ]) {
        expect(classifyMessage(inbound({ from: "postmaster@mx.prospect.test", subject }))?.category, subject).toBe(
          "soft_bounce",
        );
      }
    });

    it("Google 'Message blocked' is a provider-side policy rejection", () => {
      const s = classifyMessage(
        inbound({ from: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>", subject: "Message blocked" }),
      );
      expect(s).toMatchObject({ category: "provider_error", confidence: "medium" });
    });

    it("unrecognised DSN subjects are bounce_unclassified (low)", () => {
      const s = classifyMessage(inbound({ from: "mailer-daemon@mx.prospect.test", subject: "Notice" }));
      expect(s).toMatchObject({ category: "bounce_unclassified", confidence: "low" });
    });

    it("recognises Exchange system senders and NDR display names only with an NDR subject", () => {
      const exchange = classifyMessage(
        inbound({ from: "MicrosoftExchange329e71ec88ae4615bbc36ab6ce41109e@acme.test", subject: "Undeliverable: hi" }),
      );
      expect(exchange?.category).toBe("hard_bounce");
      const quotaWarning = classifyMessage(
        inbound({ from: "MicrosoftExchange329e71ec88ae4615bbc36ab6ce41109e@acme.test", subject: "Your mailbox is almost full" }),
      );
      expect(quotaWarning).toBeNull();
      const named = classifyMessage(
        inbound({ from: '"Mail Delivery System" <bounces@relay.test>', subject: "Undelivered Mail Returned to Sender" }),
      );
      expect(named?.category).toBe("hard_bounce");
      const outlookTest = classifyMessage(inbound({ from: '"Microsoft Outlook" <it@acme-partner.test>', subject: "Test message" }));
      expect(outlookTest).toBeNull();
    });

    it("multipart/report delivery-status is a bounce whatever the sender", () => {
      const s = classifyMessage(
        inbound({
          from: "bounces@relay.test",
          subject: "Delivery report",
          headers: { "content-type": "multipart/report; report-type=delivery-status; boundary=b" },
        }),
      );
      expect(s?.category).toBe("bounce_unclassified");
      expect(s?.classificationBasis).toContain("report-type=delivery-status");
    });

    it("takes a status code from diagnostic headers only, never inventing one", () => {
      const withCode = classifyMessage(
        inbound({
          from: "mailer-daemon@mx.test",
          subject: "Undeliverable: x",
          headers: { "diagnostic-code": "smtp; 550 5.1.1 user unknown" },
        }),
      );
      expect(withCode?.diagnosticCode).toBe("5.1.1");
      const codeOnly = classifyMessage(
        inbound({ from: "mailer-daemon@mx.test", subject: "Notice", headers: { status: "4.2.2" } }),
      );
      expect(codeOnly).toMatchObject({ category: "soft_bounce", diagnosticCode: "4.2.2" });
      const none = classifyMessage(inbound({ from: "mailer-daemon@mx.test", subject: "Undeliverable: 5.1.1 in subject" }));
      expect(none?.diagnosticCode).toBeNull();
    });

    it("delivery receipts from system senders are not bounces", () => {
      expect(classifyMessage(inbound({ from: "postmaster@acme.test", subject: "Delivered: Intro call" }))).toBeNull();
      expect(
        classifyMessage(inbound({ from: "mailer-daemon@mx.test", subject: "Delivery Status Notification (Success)" })),
      ).toBeNull();
    });
  });

  describe("auto-replies", () => {
    it("header-based auto-replies are high confidence", () => {
      expect(classifyMessage(inbound({ headers: { "auto-submitted": "auto-replied" } }))).toMatchObject({
        category: "auto_reply",
        confidence: "high",
        classificationBasis: "header:Auto-Submitted=auto-replied",
        counterpartyAddress: "pat@prospect.test",
      });
      expect(classifyMessage(inbound({ headers: { "x-autoreply": "yes" } }))?.confidence).toBe("high");
      expect(classifyMessage(inbound({ headers: { "x-autorespond": "1" } }))?.category).toBe("auto_reply");
      expect(classifyMessage(inbound({ headers: { precedence: "auto_reply" } }))?.category).toBe("auto_reply");
    });

    it("Auto-Submitted: no is not an auto-reply", () => {
      expect(classifyMessage(inbound({ headers: { "auto-submitted": "no" } }))).toBeNull();
    });

    it("subject-based auto-replies are medium confidence", () => {
      for (const subject of ["Automatic reply: Intro call", "Auto: Intro", "Out of Office: back Monday", "AutoReply: thanks"]) {
        expect(classifyMessage(inbound({ subject })), subject).toMatchObject({ category: "auto_reply", confidence: "medium" });
      }
    });

    it("an auto-reply carrying In-Reply-To is auto_reply, not reply", () => {
      const s = classifyMessage(
        inbound({
          subject: "Automatic reply: Intro call",
          headers: { "in-reply-to": "<abc@acme.test>", "auto-submitted": "auto-replied" },
          isReplyToOurThread: true,
        }),
      );
      expect(s?.category).toBe("auto_reply");
    });
  });

  describe("unsubscribe requests", () => {
    it("detects unsubscribe subjects after stripping reply prefixes", () => {
      for (const subject of ["unsubscribe", "UNSUBSCRIBE me please", "Re: Unsubscribe", "AW: SV: unsubscribe"]) {
        expect(classifyMessage(inbound({ subject })), subject).toMatchObject({
          category: "unsubscribe",
          confidence: "medium",
          counterpartyAddress: "pat@prospect.test",
        });
      }
    });

    it("does not treat 'Unsubscribed…' notices or DSNs as requests", () => {
      expect(classifyMessage(inbound({ subject: "Unsubscribed from our newsletter" }))).toBeNull();
      expect(classifyMessage(inbound({ from: "mailer-daemon@mx.test", subject: "unsubscribe" }))?.category).toBe(
        "bounce_unclassified",
      );
    });
  });

  describe("replies", () => {
    it("In-Reply-To / References make a medium-confidence reply", () => {
      expect(classifyMessage(inbound({ headers: { "in-reply-to": "<abc@acme.test>" } }))).toMatchObject({
        category: "reply",
        confidence: "medium",
        counterpartyAddress: "pat@prospect.test",
      });
      expect(classifyMessage(inbound({ headers: { references: "<abc@acme.test>" } }))?.category).toBe("reply");
    });

    it("header evidence plus our thread is high confidence", () => {
      const s = classifyMessage(inbound({ headers: { "in-reply-to": "<abc@acme.test>" }, isReplyToOurThread: true }));
      expect(s).toMatchObject({ category: "reply", confidence: "high" });
      expect(s?.classificationBasis).toContain("thread:contains-sent-message");
    });

    it("thread evidence alone is medium confidence", () => {
      expect(classifyMessage(inbound({ isReplyToOurThread: true }))).toMatchObject({ category: "reply", confidence: "medium" });
    });

    it("a confirmed foreign thread is not a reply to this mailbox", () => {
      expect(classifyMessage(inbound({ headers: { "in-reply-to": "<x@else.test>" }, isReplyToOurThread: false }))).toBeNull();
    });
  });

  it("other multipart/report types are unknown (low)", () => {
    const s = classifyMessage(
      inbound({ headers: { "content-type": "multipart/report; report-type=disposition-notification" } }),
    );
    expect(s).toMatchObject({
      category: "unknown",
      confidence: "low",
      classificationBasis: "header:Content-Type report-type=disposition-notification",
    });
  });

  it("ordinary inbound mail is not an event", () => {
    expect(classifyMessage(inbound({}))).toBeNull();
    expect(classifyMessage(inbound({ subject: null, from: null }))).toBeNull();
  });

  it("the mailbox's own inbound copies are ignored", () => {
    expect(classifyMessage(inbound({ from: MAILBOX, subject: "Re: note to self", headers: { "in-reply-to": "<a@b>" } }))).toBeNull();
  });

  it("never copies the subject into the signal", () => {
    const marker = "Secret Project Zephyr 7731";
    const cases: ClassifyInput[] = [
      { ...inbound({ subject: marker }), direction: "outbound", from: MAILBOX },
      inbound({ subject: `Undeliverable: ${marker}`, from: "postmaster@acme.test" }),
      inbound({ subject: `Delivery Status Notification (Delay) ${marker}`, from: "mailer-daemon@googlemail.com" }),
      inbound({ subject: `Delivery Status Notification (Failure) ${marker}`, from: "mailer-daemon@googlemail.com", headers: { "x-failed-recipients": "a@b.test" } }),
      inbound({ subject: `Message blocked ${marker}`, from: "mailer-daemon@googlemail.com" }),
      inbound({ subject: `${marker}`, from: "mailer-daemon@mx.test" }),
      inbound({ subject: `You have reached a limit for sending mail ${marker}`, from: "mail-noreply@google.com" }),
      inbound({ subject: `Automatic reply: ${marker}` }),
      inbound({ subject: `Re: ${marker}`, headers: { "auto-submitted": "auto-replied" } }),
      inbound({ subject: `Unsubscribe ${marker}` }),
      inbound({ subject: `Re: ${marker}`, headers: { "in-reply-to": "<a@b>" }, isReplyToOurThread: true }),
      inbound({ subject: marker, headers: { "content-type": "multipart/report; report-type=feedback-report" } }),
      inbound({ subject: marker, headers: { "content-type": "multipart/report; report-type=disposition-notification" } }),
    ];
    for (const input of cases) {
      const s = classifyMessage(input);
      expect(s, input.subject ?? "").not.toBeNull();
      const serialized = JSON.stringify(s);
      expect(serialized).not.toContain("Zephyr");
      expect(serialized).not.toContain("7731");
    }
  });

  it("does not echo arbitrary header values into the basis", () => {
    const s = classifyMessage(inbound({ headers: { "auto-submitted": "auto-generated; <script>Zephyr</script>" } }));
    expect(s?.classificationBasis).toBe("header:Auto-Submitted=auto-generated");
    expect(s?.confidence).toBe("medium");
  });
});
