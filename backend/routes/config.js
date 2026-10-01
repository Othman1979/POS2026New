const express = require('express');
const {
    DEFAULT_BUSINESS_TIME_ZONE,
    getBusinessDayStartHour,
    getBusinessSqlOffset
} = require('../utils/businessDate');

const router = express.Router();

router.get('/business', (req, res) => {
    res.json({
        success: true,
        business_sql_offset: getBusinessSqlOffset(),
        business_day_start_hour: getBusinessDayStartHour(),
        business_time_zone: DEFAULT_BUSINESS_TIME_ZONE,
    });
});

module.exports = router;
