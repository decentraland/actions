import { isRetryable, Sleep, withRetry } from "../src/retry";

/** Builds an error shaped like an HTTP failure from fetch-based clients. */
function httpError(message: string, status: number): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

describe("when checking whether a failure is retryable", () => {
  describe("and the error carries a 500 status", () => {
    let error: Error & { status: number };

    beforeEach(() => {
      error = httpError("internal error", 500);
    });

    it("should report it as retryable", () => {
      expect(isRetryable(error)).toBe(true);
    });
  });

  describe("and the error carries a 503 status", () => {
    let error: Error & { status: number };

    beforeEach(() => {
      error = httpError("service unavailable", 503);
    });

    it("should report it as retryable", () => {
      expect(isRetryable(error)).toBe(true);
    });
  });

  describe("and the error carries a 429 status", () => {
    let error: Error & { status: number };

    beforeEach(() => {
      error = httpError("too many requests", 429);
    });

    it("should report it as retryable", () => {
      expect(isRetryable(error)).toBe(true);
    });
  });

  describe("and the error carries a 400 status", () => {
    let error: Error & { status: number };

    beforeEach(() => {
      error = httpError("bad request", 400);
    });

    it("should report it as not retryable", () => {
      expect(isRetryable(error)).toBe(false);
    });
  });

  describe("and the error carries a 404 status", () => {
    let error: Error & { status: number };

    beforeEach(() => {
      error = httpError("not found", 404);
    });

    it("should report it as not retryable", () => {
      expect(isRetryable(error)).toBe(false);
    });
  });

  describe("and the error carries no status at all", () => {
    let error: Error;

    beforeEach(() => {
      error = new Error("ECONNRESET");
    });

    it("should report it as retryable because no response was received", () => {
      expect(isRetryable(error)).toBe(true);
    });
  });

  describe("and the thrown value is undefined", () => {
    let error: unknown;

    beforeEach(() => {
      error = undefined;
    });

    it("should report it as retryable", () => {
      expect(isRetryable(error)).toBe(true);
    });
  });
});

describe("when running an operation with retry", () => {
  let sleep: jest.MockedFunction<Sleep>;
  let onRetry: jest.MockedFunction<(m: string) => void>;

  beforeEach(() => {
    sleep = jest.fn().mockResolvedValue(undefined);
    onRetry = jest.fn();
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe("and the operation succeeds on the first attempt", () => {
    let fn: jest.MockedFunction<() => Promise<string>>;

    beforeEach(() => {
      fn = jest.fn();
      fn.mockResolvedValueOnce("kv written");
    });

    it("should resolve with the operation result", async () => {
      await expect(withRetry("kv-put", fn, { sleep, onRetry })).resolves.toBe("kv written");
    });

    it("should call the operation exactly once", async () => {
      await withRetry("kv-put", fn, { sleep, onRetry });

      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("should never sleep", async () => {
      await withRetry("kv-put", fn, { sleep, onRetry });

      expect(sleep).not.toHaveBeenCalled();
    });

    it("should not report any retry", async () => {
      await withRetry("kv-put", fn, { sleep, onRetry });

      expect(onRetry).not.toHaveBeenCalled();
    });
  });

  describe("and the operation fails with a 500 and then succeeds", () => {
    let fn: jest.MockedFunction<() => Promise<string>>;

    beforeEach(() => {
      fn = jest.fn();
      fn.mockRejectedValueOnce(httpError("boom", 500)).mockResolvedValueOnce("kv written");
    });

    it("should resolve with the result of the successful attempt", async () => {
      await expect(
        withRetry("kv-put", fn, { attempts: 3, baseDelayMs: 100, sleep, onRetry }),
      ).resolves.toBe("kv written");
    });

    it("should call the operation twice", async () => {
      await withRetry("kv-put", fn, { attempts: 3, baseDelayMs: 100, sleep, onRetry });

      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("should sleep once for the base delay before retrying", async () => {
      await withRetry("kv-put", fn, { attempts: 3, baseDelayMs: 100, sleep, onRetry });

      expect(sleep).toHaveBeenCalledWith(100);
    });

    it("should report the retry once with the label, the attempt and the error message", async () => {
      await withRetry("kv-put", fn, { attempts: 3, baseDelayMs: 100, sleep, onRetry });

      expect(onRetry).toHaveBeenCalledWith("kv-put failed (attempt 1/3), retrying in 100ms: boom");
    });
  });

  describe("and the operation fails with a 429 and then succeeds", () => {
    let fn: jest.MockedFunction<() => Promise<string>>;

    beforeEach(() => {
      fn = jest.fn();
      fn.mockRejectedValueOnce(httpError("rate limited", 429)).mockResolvedValueOnce("call sent");
    });

    it("should resolve with the result of the successful attempt", async () => {
      await expect(
        withRetry("broker call", fn, { attempts: 3, baseDelayMs: 100, sleep, onRetry }),
      ).resolves.toBe("call sent");
    });

    it("should call the operation twice", async () => {
      await withRetry("broker call", fn, { attempts: 3, baseDelayMs: 100, sleep, onRetry });

      expect(fn).toHaveBeenCalledTimes(2);
    });
  });

  describe("and the operation fails with an error that carries no status", () => {
    let fn: jest.MockedFunction<() => Promise<string>>;

    beforeEach(() => {
      fn = jest.fn();
      fn.mockRejectedValueOnce(new Error("ECONNRESET")).mockResolvedValueOnce("kv written");
    });

    it("should treat the network error as retryable and resolve on the retry", async () => {
      await expect(
        withRetry("kv-put", fn, { attempts: 3, baseDelayMs: 100, sleep, onRetry }),
      ).resolves.toBe("kv written");
    });

    it("should call the operation twice", async () => {
      await withRetry("kv-put", fn, { attempts: 3, baseDelayMs: 100, sleep, onRetry });

      expect(fn).toHaveBeenCalledTimes(2);
    });
  });

  describe("and every attempt fails with a retryable error", () => {
    describe("and three attempts are configured", () => {
      let fn: jest.MockedFunction<() => Promise<string>>;
      let lastError: Error & { status: number };

      beforeEach(() => {
        lastError = httpError("third boom", 500);
        fn = jest.fn();
        fn.mockRejectedValueOnce(httpError("first boom", 500))
          .mockRejectedValueOnce(httpError("second boom", 503))
          .mockRejectedValueOnce(lastError);
      });

      it("should reject with the error from the last attempt", async () => {
        await expect(
          withRetry("kv-put", fn, { attempts: 3, baseDelayMs: 100, sleep, onRetry }),
        ).rejects.toBe(lastError);
      });

      it("should call the operation once per configured attempt", async () => {
        await expect(
          withRetry("kv-put", fn, { attempts: 3, baseDelayMs: 100, sleep, onRetry }),
        ).rejects.toBe(lastError);

        expect(fn).toHaveBeenCalledTimes(3);
      });

      it("should sleep between attempts but not after the last failure", async () => {
        await expect(
          withRetry("kv-put", fn, { attempts: 3, baseDelayMs: 100, sleep, onRetry }),
        ).rejects.toBe(lastError);

        expect(sleep).toHaveBeenCalledTimes(2);
      });
    });

    describe("and four attempts are configured", () => {
      let fn: jest.MockedFunction<() => Promise<string>>;
      let lastError: Error & { status: number };

      beforeEach(() => {
        lastError = httpError("fourth boom", 500);
        fn = jest.fn();
        fn.mockRejectedValueOnce(httpError("first boom", 500))
          .mockRejectedValueOnce(httpError("second boom", 500))
          .mockRejectedValueOnce(httpError("third boom", 500))
          .mockRejectedValueOnce(lastError);
      });

      it("should double the backoff delay on every retry", async () => {
        await expect(
          withRetry("kv-put", fn, { attempts: 4, baseDelayMs: 100, sleep, onRetry }),
        ).rejects.toBe(lastError);

        expect(sleep.mock.calls).toEqual([[100], [200], [400]]);
      });

      it("should report one retry per backoff with the doubling delay in the message", async () => {
        await expect(
          withRetry("kv-put", fn, { attempts: 4, baseDelayMs: 100, sleep, onRetry }),
        ).rejects.toBe(lastError);

        expect(onRetry.mock.calls).toEqual([
          ["kv-put failed (attempt 1/4), retrying in 100ms: first boom"],
          ["kv-put failed (attempt 2/4), retrying in 200ms: second boom"],
          ["kv-put failed (attempt 3/4), retrying in 400ms: third boom"],
        ]);
      });
    });
  });

  describe("and the operation fails with a client error", () => {
    describe("and the status is 400", () => {
      let fn: jest.MockedFunction<() => Promise<string>>;
      let error: Error & { status: number };

      beforeEach(() => {
        error = httpError("bad request", 400);
        fn = jest.fn();
        fn.mockRejectedValueOnce(error).mockResolvedValueOnce("never reached");
      });

      it("should reject with that error", async () => {
        await expect(
          withRetry("kv-put", fn, { attempts: 3, baseDelayMs: 100, sleep, onRetry }),
        ).rejects.toBe(error);
      });

      it("should call the operation only once", async () => {
        await expect(
          withRetry("kv-put", fn, { attempts: 3, baseDelayMs: 100, sleep, onRetry }),
        ).rejects.toBe(error);

        expect(fn).toHaveBeenCalledTimes(1);
      });

      it("should never sleep", async () => {
        await expect(
          withRetry("kv-put", fn, { attempts: 3, baseDelayMs: 100, sleep, onRetry }),
        ).rejects.toBe(error);

        expect(sleep).not.toHaveBeenCalled();
      });
    });

    describe("and the status is 404", () => {
      let fn: jest.MockedFunction<() => Promise<string>>;
      let error: Error & { status: number };

      beforeEach(() => {
        error = httpError("not found", 404);
        fn = jest.fn();
        fn.mockRejectedValueOnce(error).mockResolvedValueOnce("never reached");
      });

      it("should reject with that error", async () => {
        await expect(
          withRetry("kv-put", fn, { attempts: 3, baseDelayMs: 100, sleep, onRetry }),
        ).rejects.toBe(error);
      });

      it("should call the operation only once", async () => {
        await expect(
          withRetry("kv-put", fn, { attempts: 3, baseDelayMs: 100, sleep, onRetry }),
        ).rejects.toBe(error);

        expect(fn).toHaveBeenCalledTimes(1);
      });

      it("should not report a retry", async () => {
        await expect(
          withRetry("kv-put", fn, { attempts: 3, baseDelayMs: 100, sleep, onRetry }),
        ).rejects.toBe(error);

        expect(onRetry).not.toHaveBeenCalled();
      });
    });
  });

  describe("and no sleep or retry reporter is provided", () => {
    let fn: jest.MockedFunction<() => Promise<string>>;

    beforeEach(() => {
      fn = jest.fn();
      fn.mockRejectedValueOnce(httpError("boom", 500)).mockResolvedValueOnce("kv written");
    });

    it("should still retry using the default sleep and resolve", async () => {
      await expect(withRetry("kv-put", fn, { attempts: 2, baseDelayMs: 1 })).resolves.toBe(
        "kv written",
      );
    });
  });
});

describe("when the callback throws a programming error", () => {
  let sleep: jest.Mock;
  let fn: jest.Mock;

  beforeEach(() => {
    sleep = jest.fn().mockResolvedValue(undefined);
    fn = jest.fn().mockRejectedValue(new TypeError("cannot read properties of undefined"));
  });

  // Retrying a bug just repeats the same stack trace and buries the cause
  // under two misleading "transient failure, retrying" warnings.
  it("should not treat it as transient", () => {
    expect(isRetryable(new TypeError("boom"))).toBe(false);
  });

  it("should not retry a ReferenceError either", () => {
    expect(isRetryable(new ReferenceError("boom"))).toBe(false);
  });

  it("should give up after a single attempt", async () => {
    await expect(withRetry("op", fn, { sleep })).rejects.toThrow("cannot read properties");

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("should not back off", async () => {
    await expect(withRetry("op", fn, { sleep })).rejects.toThrow();

    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("when the broker reports a rollout already in progress", () => {
  /**
   * The broker answers 409 with a Retry-After and means "wait": another rollout holds the
   * lease on that key and finishes in well under a second. Treating it as terminal failed
   * deploys the server intended to succeed — including the case where a client retry after
   * an API Gateway 504 collided with its own first invocation still holding the lease.
   */
  it("should treat it as transient despite being a 4xx", () => {
    expect(isRetryable({ status: 409, code: "rollout_in_progress" })).toBe(true);
  });

  it("should still treat other 409s as the caller's problem", () => {
    expect(isRetryable({ status: 409, code: "version_already_published" })).toBe(false);
    expect(isRetryable({ status: 409, code: "source_not_ready" })).toBe(false);
  });

  it("should still refuse to retry an ordinary refusal", () => {
    expect(isRetryable({ status: 403, code: "repository_mismatch" })).toBe(false);
  });
});
