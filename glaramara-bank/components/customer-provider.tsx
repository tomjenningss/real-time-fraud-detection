"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";

import { bankingFetch, type DemoLocation, type DemoSessionResponse } from "@/lib/banking-api";
import { customers, type DemoCustomer } from "@/lib/demo-data";

type CustomerContextValue = {
  customer: DemoCustomer;
  customers: DemoCustomer[];
  locations: DemoLocation[];
  sessionReady: boolean;
  sessionError: string | null;
  switching: boolean;
  setCustomerId: (id: string) => Promise<void>;
};

const CustomerContext = createContext<CustomerContextValue | null>(null);

export function CustomerProvider({ children }: { children: React.ReactNode }) {
  const [customerId, setCustomerId] = useState(customers[0].id);
  const [availableCustomers, setAvailableCustomers] = useState(customers);
  const [locations, setLocations] = useState<DemoLocation[]>([]);
  const [sessionReady, setSessionReady] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    let active = true;
    bankingFetch<DemoSessionResponse>("/api/v1/demo/session")
      .then((response) => {
        if (!active) return;
        setAvailableCustomers(response.customers);
        setLocations(response.locations);
        setCustomerId(response.session.customerId);
        setSessionError(null);
        setSessionReady(true);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setSessionError(
          cause instanceof Error ? cause.message : "The fictional banking session is unavailable.",
        );
      });
    return () => {
      active = false;
    };
  }, []);

  const value = useMemo(() => {
    const customer =
      availableCustomers.find((item) => item.id === customerId) ?? availableCustomers[0] ?? customers[0];
    return {
      customer,
      customers: availableCustomers,
      locations,
      sessionReady,
      sessionError,
      switching,
      setCustomerId: async (id: string) => {
        if (switching || !availableCustomers.some((item) => item.id === id)) return;
        setSwitching(true);
        setSessionReady(false);
        setSessionError(null);
        try {
          const response = await bankingFetch<DemoSessionResponse>("/api/v1/demo/session", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ customerId: id }),
          });
          setAvailableCustomers(response.customers);
          setLocations(response.locations);
          setCustomerId(response.session.customerId);
          setSessionReady(true);
          if (response.session.role === "FRAUD_ANALYST") window.location.assign("/fraud-operations");
          else if (window.location.pathname.startsWith("/fraud-operations")) window.location.assign("/");
        } catch (cause) {
          setSessionError(
            cause instanceof Error ? cause.message : "The fictional banking session could not be changed.",
          );
        } finally {
          setSessionReady(true);
          setSwitching(false);
        }
      },
    };
  }, [availableCustomers, customerId, locations, sessionError, sessionReady, switching]);

  return <CustomerContext.Provider value={value}>{children}</CustomerContext.Provider>;
}

export function useCustomer() {
  const value = useContext(CustomerContext);
  if (!value) throw new Error("useCustomer must be used within CustomerProvider");
  return value;
}
