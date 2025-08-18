#!/usr/bin/env node

/**
 * Comprehensive test suite for formatPrecision function
 * Based on OpenNEM specification: https://github.com/opennem/opennem/issues/446
 * 
 * OpenNEM Rules:
 * - Exactly 4 significant figures (hardcoded)
 * - Preserve all digits left of decimal point
 * - Include decimals only when precision is needed
 * - Remove trailing zeros after decimal place
 */

// Current implementation (simplified for 4 sig figs only)
function formatPrecision(value) {
  if (value === 0) {
    return 0;
  }
  
  // Calculate the order of magnitude
  const magnitude = Math.floor(Math.log10(Math.abs(value)));
  
  // Calculate decimal places needed for 4 significant figures
  const decimalPlaces = Math.max(0, 3 - magnitude);
  
  // Round to 4 significant figures
  const factor = Math.pow(10, decimalPlaces);
  const rounded = Math.round(value * factor) / factor;
  
  // If it's effectively an integer (accounting for floating point precision), return as integer
  if (Math.abs(rounded - Math.round(rounded)) < 1e-10) {
    return Math.round(rounded);
  }
  
  // Otherwise return the rounded float
  // Parse and re-format to remove trailing zeros
  const strVal = rounded.toFixed(decimalPlaces);
  return parseFloat(strVal);
}

// Color output helpers
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

console.log(`${BOLD}=============================================================`);
console.log(`COMPREHENSIVE TEST SUITE: formatPrecision Function`);
console.log(`OpenNEM Specification Compliance Test (4 sig figs hardcoded)`);
console.log(`=============================================================\n${RESET}`);

// Test categories with expected results based on OpenNEM spec (4 sig figs)
const testCategories = [
  {
    name: "ZERO HANDLING",
    tests: [
      { input: 0, expected: 0, description: "Exact zero" },
      { input: 0.0, expected: 0, description: "Float zero" },
      { input: -0, expected: 0, description: "Negative zero" },
    ]
  },
  {
    name: "INTEGERS (should remain as integers)",
    tests: [
      { input: 1, expected: 1, description: "Single digit" },
      { input: 10, expected: 10, description: "Two digits" },
      { input: 100, expected: 100, description: "Three digits" },
      { input: 1000, expected: 1000, description: "Four digits" },
      { input: 10000, expected: 10000, description: "Five digits" },
      { input: -5000, expected: -5000, description: "Negative integer" },
      { input: 1000.0, expected: 1000, description: "Integer as float" },
    ]
  },
  {
    name: "STANDARD DECIMAL NUMBERS (4 sig figs)",
    tests: [
      { input: 1234.5678, expected: 1235, description: "Round up to integer" },
      { input: 1234.4321, expected: 1234, description: "Round down to integer" },
      { input: 123.456, expected: 123.5, description: "1 decimal place" },
      { input: 12.3456, expected: 12.35, description: "2 decimal places" },
      { input: 1.23456, expected: 1.235, description: "3 decimal places" },
      { input: 0.123456, expected: 0.1235, description: "4 sig figs < 1" },
      { input: 0.0123456, expected: 0.01235, description: "Small decimal" },
      { input: 0.00123456, expected: 0.001235, description: "Very small decimal" },
    ]
  },
  {
    name: "LARGE NUMBERS (preserve all digits left of decimal)",
    tests: [
      { input: 999999.99, expected: 1000000, description: "Just under 1 million" },
      { input: 1234567, expected: 1234567, description: "7 digits (all preserved)" },
      { input: 12345678, expected: 12345678, description: "8 digits (all preserved)" },
      { input: 123456789, expected: 123456789, description: "9 digits (all preserved)" },
      { input: 1.234e10, expected: 12340000000, description: "Scientific notation" },
      { input: 1234567.89, expected: 1234568, description: "Large with decimals (round decimals only)" },
      { input: 1234.5678, expected: 1235, description: "4+ digits, round to integer" },
    ]
  },
  {
    name: "SMALL NUMBERS",
    tests: [
      { input: 0.00012345, expected: 0.0001235, description: "4 decimal places" },
      { input: 0.000012345, expected: 0.00001235, description: "5 decimal places" },
      { input: 1.234e-6, expected: 0.000001234, description: "Micro scale" },
      { input: 1.234e-9, expected: 0.000000001234, description: "Nano scale" },
    ]
  },
  {
    name: "NEGATIVE NUMBERS",
    tests: [
      { input: -1234.5678, expected: -1235, description: "Negative round up" },
      { input: -123.456, expected: -123.5, description: "Negative 1 decimal" },
      { input: -12.3456, expected: -12.35, description: "Negative 2 decimals" },
      { input: -0.123456, expected: -0.1235, description: "Negative < 1" },
      { input: -0.001, expected: -0.001, description: "Negative small" },
    ]
  },
  {
    name: "EDGE CASES",
    tests: [
      { input: 0.9999, expected: 0.9999, description: "Near 1" },
      { input: 9.9999, expected: 10, description: "Round to 10" },
      { input: 99.999, expected: 100, description: "Round to 100" },
      { input: 999.99, expected: 1000, description: "Round to 1000" },
      { input: 9999.9, expected: 10000, description: "Round to 10000" },
      { input: 0.00009999, expected: 0.00009999, description: "Small with many 9s" },
    ]
  },
  {
    name: "TRAILING ZEROS (should be removed)",
    tests: [
      { input: 1.2000, expected: 1.2, description: "Remove trailing zeros" },
      { input: 12.30, expected: 12.3, description: "One trailing zero" },
      { input: 100.00, expected: 100, description: "Integer with decimal zeros" },
      { input: 0.1000, expected: 0.1, description: "Decimal with trailing zeros" },
    ]
  },
  {
    name: "SPECIAL VALUES",
    tests: [
      { input: NaN, expected: NaN, description: "NaN handling", special: true },
      { input: Infinity, expected: Infinity, description: "Positive infinity", special: true },
      { input: -Infinity, expected: -Infinity, description: "Negative infinity", special: true },
    ]
  },
  {
    name: "POWER VALUES (typical for energy data)",
    tests: [
      { input: 2500, expected: 2500, description: "2.5kW as watts" },
      { input: 2567, expected: 2567, description: "2.567kW as watts" },
      { input: 2567.89, expected: 2568, description: "Round to nearest watt" },
      { input: 250.5, expected: 250.5, description: "Quarter kilowatt" },
      { input: 25.55, expected: 25.55, description: "Small power value" },
      { input: 0.5, expected: 0.5, description: "Half watt" },
      { input: -1500, expected: -1500, description: "Negative power (export)" },
      { input: -1567.89, expected: -1568, description: "Negative with decimals" },
    ]
  },
  {
    name: "PERCENTAGE VALUES (battery SOC)",
    tests: [
      { input: 100, expected: 100, description: "Full charge" },
      { input: 99.9, expected: 99.9, description: "Near full" },
      { input: 50.5, expected: 50.5, description: "Half charge" },
      { input: 25.25, expected: 25.25, description: "Quarter charge" },
      { input: 0.1, expected: 0.1, description: "Nearly empty" },
      { input: 75.5555, expected: 75.56, description: "Precise percentage" },
    ]
  }
];

// Run tests
let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
const failures = [];

testCategories.forEach(category => {
  console.log(`${BLUE}${BOLD}${category.name}${RESET}`);
  console.log('-'.repeat(category.name.length));
  
  category.tests.forEach(test => {
    totalTests++;
    const result = formatPrecision(test.input);
    const passed = test.special ? 
      (isNaN(result) && isNaN(test.expected)) || result === test.expected :
      Math.abs(result - test.expected) < 1e-10;
    
    if (passed) {
      passedTests++;
      console.log(`${GREEN}✓${RESET} ${test.description.padEnd(30)} ${String(test.input).padEnd(15)} → ${result}`);
    } else {
      failedTests++;
      failures.push({ ...test, result, category: category.name });
      console.log(`${RED}✗${RESET} ${test.description.padEnd(30)} ${String(test.input).padEnd(15)} → ${result} ${RED}(expected: ${test.expected})${RESET}`);
    }
  });
  console.log();
});

// Performance test with real-world data
console.log(`${BLUE}${BOLD}PERFORMANCE TEST WITH REAL-WORLD DATA${RESET}`);
console.log('--------------------------------------');

// Generate realistic power data (watts)
const powerData = [];
for (let i = 0; i < 1000; i++) {
  // Mix of different power ranges
  if (i % 4 === 0) {
    // Solar power: 0-5000W
    powerData.push(Math.random() * 5000);
  } else if (i % 4 === 1) {
    // Load power: 100-3000W
    powerData.push(100 + Math.random() * 2900);
  } else if (i % 4 === 2) {
    // Battery power: -3000 to 3000W
    powerData.push((Math.random() * 6000) - 3000);
  } else {
    // Grid power: -5000 to 5000W
    powerData.push((Math.random() * 10000) - 5000);
  }
}

// Benchmark
const iterations = 100000;
console.log(`Testing ${iterations} iterations on ${powerData.length} realistic values...`);

// Warm up
for (let i = 0; i < 1000; i++) {
  formatPrecision(powerData[i % powerData.length]);
}

const start = process.hrtime.bigint();
for (let i = 0; i < iterations; i++) {
  formatPrecision(powerData[i % powerData.length]);
}
const end = process.hrtime.bigint();

const timeMs = Number(end - start) / 1000000;
const opsPerSecond = (iterations / (timeMs / 1000)).toFixed(0);
const nsPerOp = Number(end - start) / iterations;

console.log(`Time: ${timeMs.toFixed(2)}ms`);
console.log(`Operations/second: ${Number(opsPerSecond).toLocaleString()}`);
console.log(`Nanoseconds/operation: ${nsPerOp}ns`);
console.log();

// Summary
console.log(`${BOLD}=============================================================`);
console.log(`TEST SUMMARY${RESET}`);
console.log(`${BOLD}=============================================================\n${RESET}`);

console.log(`Total Tests: ${totalTests}`);
console.log(`${GREEN}Passed: ${passedTests}${RESET}`);
console.log(`${RED}Failed: ${failedTests}${RESET}`);

if (failedTests > 0) {
  console.log(`\n${RED}${BOLD}FAILED TESTS:${RESET}`);
  failures.forEach(failure => {
    console.log(`${RED}  ${failure.category} - ${failure.description}:`);
    console.log(`    Input: ${failure.input}, Expected: ${failure.expected}, Got: ${failure.result}${RESET}`);
  });
  process.exit(1);
} else {
  console.log(`\n${GREEN}${BOLD}✓ All tests passed! Function complies with OpenNEM specification.${RESET}`);
}

// Additional validation info
console.log(`\n${YELLOW}${BOLD}OPENNEM COMPLIANCE NOTES:${RESET}`);
console.log(`
1. ✓ Maintains exactly 4 significant figures (hardcoded)
2. ✓ Preserves all digits left of decimal point  
3. ✓ Includes decimals only when precision is needed
4. ✓ Removes trailing zeros after decimal place
5. ✓ Handles negative numbers correctly
6. ✓ Handles special values (NaN, Infinity)
7. ✓ Works with typical energy data ranges
`);