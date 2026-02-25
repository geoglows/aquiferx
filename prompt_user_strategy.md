# User and Data Management Strategy

This application is called the Aquifer Analyst. We are preparing it to be part of a new suite of web applications associated with the GEOGLOWS organization. A prototype of he landing page for this new set of apps can be found here:

https://dev.apps.geoglows.org/

We have users all over the world. The Aquifer Analyst app is one of two apps related to groundwater. The purpose of this document is to explore and design a strategy for user and data management. 

## Overview

For all of our apps, we want to have some way to track usage. One way to do this is to have user accounts. People should be able to create a free user account. We could use this to help us track engagement.

Also, some of the apps require the user to upload their own data for visualization and analysis. We would like to have a way to store that data in a way that the user could revisit the site and browse the data.

For the Aquifer Analyst, users can upload regional groundwater data. This consists of a region boundary, aquifer boundaries, wells, and measurements (including water levels). These are current stored in a series of CSV and JSON files in folders organized by region in the public/data directory. 

## Use Cases

Here are some scenarios we anticipate. While we may have some users who are individuals, we anticipate users who are part of an organization, such as water agencies. They may want to share access to the same data. For example, one organization may need:

**admin** - one or more users who have the ability to both view and manage data. Manage data means that they can upload data and create storage maps - anything that creates new data in the public/data folder.

**viewer** - users within the organization that can view but not edit the data.

Furthermore, some agencies may want to upload, manage, and view data within the organization, but not have it publicly accessible. Other agencies may want to manage and view the data, but also have the data publicly available. Perhaps this could be done via a URL variable or something. 

There is yet another category of organization that considers their groundwater data to be a state secret. Not only do they not allow public viewing, they do not trust their data to be uploaded to a web site or remote storage. This type of user would need some way to view data locally, perhaps through an upload/download process that keeps the data strictly on the local computer. It could stay in the cache, but generally require a quick upload of the database for viewing.

## Hosting

Right now we are hosting the main portal on github. We have considered using Vercel also. Need some suggestions

## Data Storage

I need advice on how to organize and store data. How do we associate data with accounts? What format should we use for remote storage? Keep our file format, or put things in a database?

One thing we need to consider is concurrent use. Suppose an organization has multiple people with admin access. Two or more people could be using the service and the same time and making edits to the data. How do we keep data syncrhonized and avoid conflicts? 