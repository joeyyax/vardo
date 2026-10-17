"use client";

import { createContext, useContext } from "react";

const TimeZoneContext = createContext("UTC");

/** The org's time zone for everything uptime prints under it. */
export const UptimeTimeZone = TimeZoneContext.Provider;

export const useUptimeTimeZone = (): string => useContext(TimeZoneContext);
