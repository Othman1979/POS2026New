function expectMoney(actual, expected, precision = 2) {
    expect(Number(actual || 0)).toBeCloseTo(Number(expected), precision);
}

module.exports = {
    expectMoney,
};
